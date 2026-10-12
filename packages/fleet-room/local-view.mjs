import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { roomControl } from '../fleet-worker/src/room-control.mjs';

const ID = /^[A-Za-z0-9_-]{1,96}$/;
export class LocalRoomView {
  constructor({ storage, id, url, fleetHome }) {
    if (!ID.test(id)) throw new Error('Invalid local leader ID');
    this.storage = storage;
    this.descriptor = { version: 1, leaderId: id, instanceId: randomUUID(), url, readCapability: randomBytes(32).toString('hex') };
    this.directory = join(resolve(fleetHome || process.env.FLEET_HOME || join(homedir(), '.fleet-agent')), 'rooms');
    this.path = join(this.directory, `${id}.json`);
  }
  publish() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Local Room discovery directory must be private and owned');
    // A user's home may itself be an alias (e.g. /home -> /data00/home).
    // Reject a symlink at the discovery directory itself, then use its canonical
    // path so ordinary home aliases do not break startup or instance cleanup.
    this.directory = realpathSync(this.directory);
    this.path = join(this.directory, `${this.descriptor.leaderId}.json`);
    // An existing (even stale) descriptor requires explicit operator cleanup.
    writeFileSync(this.path, JSON.stringify(this.descriptor), { flag: 'wx', mode: 0o600 });
    this.inode = lstatSync(this.path).ino;
  }
  close() {
    if (!this.inode) return;
    try {
      const stat = lstatSync(this.path);
      if (stat.isFile() && stat.ino === this.inode && stat.size <= 4096 && JSON.parse(readFileSync(this.path, 'utf8')).instanceId === this.descriptor.instanceId) unlinkSync(this.path);
    } catch { /* A missing or replaced descriptor is no longer ours to remove. */ }
    this.inode = undefined;
  }
  async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const deny = (status, code) => { res.writeHead(status); res.end(JSON.stringify({ error: code })); };
    const expected = Buffer.from(`Bearer ${this.descriptor.readCapability}`);
    const received = Buffer.from(req.headers.authorization || '');
    if (req.headers.host !== new URL(this.descriptor.url).host || (req.headers.origin && req.headers.origin !== this.descriptor.url) || received.length !== expected.length || !timingSafeEqual(received, expected)) return deny(403, 'forbidden');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return deny(405, 'read_only'); }
    try {
      const url = new URL(req.url, this.descriptor.url);
      let action, input;
      if (url.pathname === '/rooms' && !url.search) { action = 'rooms.list'; input = {}; }
      else if (url.pathname === '/messages') {
        const allowed = new Set(['roomId', 'discussionId', 'afterSeq', 'limit']);
        for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error('Invalid query');
        input = { roomId: url.searchParams.get('roomId'), discussionId: url.searchParams.get('discussionId') || 'main' };
        if (!ID.test(input.roomId || '') || !ID.test(input.discussionId)) throw new Error('Invalid ID');
        for (const key of ['afterSeq', 'limit']) if (url.searchParams.has(key)) {
          const value = url.searchParams.get(key);
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid cursor');
          input[key] = Number(value);
        }
        if (input.limit !== undefined && (input.limit < 1 || input.limit > 100)) throw new Error('Invalid limit');
        action = 'messages.read';
      } else return deny(404, 'not_found');
      const principal = { kind: 'user', id: 'local-view' };
      const result = await roomControl(this.storage, principal, action, input);
      const { agents } = await roomControl(this.storage, principal, 'agents.list', {});
      const names = new Map(agents.map((agent) => [agent.id, agent.name]));
      const agentName = (id) => names.get(id) || id;
      if (action === 'rooms.list') {
        result.rooms = result.rooms.map((room) => ({ ...room, leaderName: agentName(room.leaderId) }));
      } else {
        result.messages = result.messages.map((message) => ({ ...message,
          authorName: message.authorKind === 'agent' ? agentName(message.authorId) : message.authorId,
          ...(message.toAgentId ? { toAgentName: agentName(message.toAgentId) } : {}),
        }));
      }
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > 128 * 1024) return deny(413, 'response_too_large');
      res.end(body);
    } catch { deny(400, 'unavailable_or_invalid_query'); }
  }
}
