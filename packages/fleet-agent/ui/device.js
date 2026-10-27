(() => {
  'use strict';
  const labels = [];
  const chinese = () => document.documentElement.lang.startsWith('zh');
  const label = (node, zh, en, property = 'textContent') => {
    labels.push({ node, zh, en, property });
    node[property] = chinese() ? zh : en;
    return node;
  };
  const text = (tag, value) => {
    const node = document.createElement(tag);
    node.textContent = String(value ?? '');
    return node;
  };
  const control = (tag, zh, en) => label(text(tag, ''), zh, en);
  const input = (zh, en) => label(document.createElement('input'), zh, en, 'placeholder');
  const card = (zh, en) => {
    const node = document.createElement('section');
    node.className = 'card';
    node.append(control('h2', zh, en));
    document.querySelector('.wrap').append(node);
    return node;
  };
  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  const storageCard = card('活动记录与执行收据加密', 'Encrypt activity and execution receipts');
  const storageState = text('p', '');
  const storagePassword = input('口令（留空使用系统钥匙串）', 'Passphrase (empty uses system key store)');
  storagePassword.type = 'password';
  storagePassword.autocomplete = 'off';
  const enableStorage = control('button', '启用加密', 'Enable encryption');
  const unlockStorage = control('button', '解锁存储', 'Unlock storage');
  storageCard.append(storageState, storagePassword, enableStorage, unlockStorage);
  async function storageStatus() {
    try {
      const state = await api('/api/storage');
      enableStorage.disabled = state.configured;
      unlockStorage.disabled = !state.configured || !state.locked;
      storageState.textContent = state.locked ? (chinese() ? '存储已锁定，操作暂停；请在本机解锁。' : 'Storage locked; unlock locally to resume operations.')
        : state.activity_encrypted && state.receipts_encrypted ? (chinese() ? '活动记录和执行收据已加密。工作区保护以插件能力为准。' : 'Activity and execution receipts encrypted. Workspace protection depends on plugin capabilities.')
        : (chinese() ? '尚未启用加密。配置前请停用设备并结束运行任务。' : 'Encryption not enabled. Disable device and finish running tasks before setup.');
    } catch (error) { storageState.textContent = error.message; }
  }
  async function changeStorage(action) {
    try {
      await api('/api/storage/' + action, { password: storagePassword.value });
      storagePassword.value = '';
      await storageStatus();
    } catch (error) { storageState.textContent = error.message; }
  }
  enableStorage.onclick = () => changeStorage('setup');
  unlockStorage.onclick = () => changeStorage('unlock');
  storageStatus();
  setInterval(() => { if (!document.hidden) storageStatus(); }, 2000);

  const activityCard = card('设备活动', 'Device activity');
  const filters = document.createElement('div');
  filters.className = 'row';
  const kind = document.createElement('select');
  kind.setAttribute('aria-label', 'Activity kind');
  for (const value of ['', 'command', 'plugin', 'desktop', 'process', 'file', 'network', 'workspace', 'coverage', 'control', 'device']) {
    const option = value ? text('option', value) : control('option', '全部', 'All');
    option.value = value;
    kind.append(option);
  }
  const pluginFilter = input('插件 ID', 'Plugin ID');
  const corr = input('任务关联编号', 'Task correlation');
  const since = document.createElement('input');
  since.type = 'datetime-local';
  since.setAttribute('aria-label', 'Activity start time');
  const until = document.createElement('input');
  until.type = 'datetime-local';
  until.setAttribute('aria-label', 'Activity end time');
  const refresh = control('button', '刷新', 'Refresh');
  const older = control('button', '加载更早记录', 'Load earlier records');
  older.disabled = true;
  const download = control('a', '导出记录', 'Export journal');
  download.href = '/api/activity/export';
  download.download = 'fleet-activity.jsonl';
  filters.append(kind, pluginFilter, corr, since, until, refresh, older, download);
  activityCard.append(filters);
  const notice = text('p', '');
  const rows = document.createElement('div');
  rows.style = 'max-height:480px;overflow:auto';
  activityCard.append(notice, rows);
  let generation = 0, cursor = 0, first = 0, loading = false;
  const displayed = new Set();
  function appendEvents(events, history) {
    const fragment = document.createDocumentFragment();
    for (const event of history ? [...events].reverse() : events) {
      if (displayed.has(event.seq)) continue;
      displayed.add(event.seq);
      const row = document.createElement('details');
      row.style = 'padding:6px 0;border-bottom:1px solid var(--border)';
      row.append(text('summary', `${new Date(event.time).toLocaleString()} · ${event.kind} · ${event.phase} · ${event.summary}`));
      row.append(text('pre', JSON.stringify(event, null, 2)));
      if (history) fragment.append(row);
      else fragment.prepend(row);
    }
    if (history) rows.append(fragment);
    else rows.prepend(fragment);
  }
  async function update(reset = false, history = false) {
    if (reset) {
      generation++;
      cursor = first = 0;
      displayed.clear();
      rows.replaceChildren();
      older.disabled = true;
    } else if (loading) return;
    const current = generation;
    const initial = cursor === 0 && !history;
    loading = true;
    const query = new URLSearchParams({ after: history ? '0' : String(cursor), kind: kind.value,
      plugin_id: pluginFilter.value, corr: corr.value, limit: '200' });
    if (history) query.set('before', String(first));
    if (since.value) query.set('since', String(new Date(since.value).getTime()));
    if (until.value) query.set('until', String(new Date(until.value).getTime()));
    try {
      const page = await api('/api/activity?' + query);
      if (current !== generation) return;
      notice.textContent = page.gap ? (chinese() ? '记录保留窗口已变化，存在历史缺口' : 'Journal retention gap')
        : page.recovered_tail ? (chinese() ? '恢复了未完成的日志尾部' : 'Recovered incomplete journal tail')
        : (chinese() ? '本地持久化记录；采集覆盖以 coverage 事件为准' : 'Persistent local records; see coverage events');
      appendEvents(page.events, history);
      if (!history) cursor = page.next;
      if (page.first && (!first || page.first < first)) first = page.first;
      if (reset || history || initial) older.disabled = !page.has_earlier;
    } catch (error) {
      if (current === generation) notice.textContent = error.message;
    } finally {
      if (current === generation) loading = false;
    }
  }
  refresh.onclick = () => update(true);
  older.onclick = () => update(false, true);
  for (const filter of [kind, pluginFilter, corr, since, until]) filter.onchange = () => update(true);

  const pluginCard = card('插件', 'Plugins');
  const inventory = document.createElement('div');
  inventory.className = 'row';
  pluginCard.append(inventory);
  const installer = document.createElement('div');
  installer.className = 'row';
  const directory = input('本地开发包绝对路径', 'Absolute local package directory');
  const install = control('button', '安装或升级本地包', 'Install or upgrade local package');
  installer.append(directory, install);
  pluginCard.append(installer);
  const errorRow = text('p', '');
  const panel = document.createElement('div');
  pluginCard.append(errorRow, panel);
  let channel = null, activeToken = '', activeID = '', activeVersion = '', fingerprint = '';
  let pending = new Set();
  async function closePage() {
    const token = activeToken;
    activeToken = activeID = activeVersion = '';
    if (channel) channel.close();
    channel = null;
    panel.replaceChildren();
    if (token) await api('/api/plugins/close', { page_token: token });
  }
  async function plugins() {
    try {
      const list = await api('/api/plugins');
      const next = JSON.stringify(list.plugins);
      if (next === fingerprint) return;
      fingerprint = next;
      const active = list.plugins.find(plugin => plugin.id === activeID);
      if (activeToken && (!active || JSON.stringify(active) !== activeVersion)) await closePage();
      inventory.replaceChildren();
      for (const plugin of list.plugins) {
        const button = text('button', `${plugin.name} ${plugin.version}`);
        button.disabled = !plugin.ui;
        button.onclick = () => open(plugin);
        inventory.append(button);
      }
      if (!list.plugins.length) inventory.append(control('p', '尚未安装插件', 'No plugins installed'));
    } catch (error) { errorRow.textContent = error.message; }
  }
  install.onclick = async () => {
    try {
      await api('/api/plugins/install-local', { directory: directory.value });
      errorRow.textContent = chinese() ? '已安装' : 'Installed';
      await plugins();
    } catch (error) { errorRow.textContent = error.message; }
  };
  async function pageCall(page, pipe, data) {
    if (!data || data.type !== 'fleet.call' || typeof data.id !== 'string' || typeof data.action !== 'string') return;
    let task;
    try {
      if (activeToken !== page.page_token) throw new Error('Page closed');
      if ((page.write_actions || []).includes(data.action) && !window.confirm(`${page.title}: ${data.action}\n${chinese() ? '允许此插件页面执行？' : 'Allow this page action?'}`)) throw new Error('Canceled');
      task = await api('/api/plugins/invoke', { page_token: page.page_token, action: data.action, input: data.input || {} });
      pending.add(task.corr);
      while (activeToken === page.page_token) {
        const result = await api('/api/plugins/result?' + new URLSearchParams({ page_token: page.page_token, corr: task.corr }));
        if (result.status === 'done') {
          if (!result.ok) throw new Error(result.error || 'Plugin failed');
          pipe.port1.postMessage({ type: 'fleet.result', id: data.id, result: result.result });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) { pipe.port1.postMessage({ type: 'fleet.result', id: data.id, error: error.message }); }
    finally { if (task) pending.delete(task.corr); }
  }
  async function open(plugin) {
    try {
      await closePage();
      const page = await api('/api/plugins/open', { plugin_id: plugin.id });
      activeToken = page.page_token;
      activeID = plugin.id;
      activeVersion = JSON.stringify(plugin);
      pending = new Set();
      const cancel = control('button', '取消页面任务', 'Cancel page tasks');
      cancel.onclick = async () => {
        try { for (const corr of pending) await api('/api/plugins/cancel', { page_token: page.page_token, corr }); }
        catch (error) { errorRow.textContent = error.message; }
      };
      const viewActivity = control('button', '查看插件活动', 'View plugin activity');
      viewActivity.onclick = () => {
        pluginFilter.value = plugin.id;
        corr.value = kind.value = '';
        update(true);
        activityCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      const close = control('button', '关闭页面', 'Close page');
      close.onclick = () => closePage().catch(error => { errorRow.textContent = error.message; });
      const uninstall = control('button', '卸载并保留数据', 'Uninstall and retain data');
      uninstall.onclick = async () => {
        if (!window.confirm(`${page.title}: ${chinese() ? '卸载插件？数据将归档保留。' : 'Uninstall plugin? Data will be archived.'}`)) return;
        try {
          const result = await api('/api/plugins/uninstall-local', { plugin_id: plugin.id });
          await closePage();
          errorRow.textContent = result.data_archive;
          await plugins();
        } catch (error) { errorRow.textContent = error.message; }
      };
      panel.append(text('h2', page.title), viewActivity, cancel, close, uninstall);
      const frame = document.createElement('iframe');
      frame.title = page.title;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style = 'width:100%;height:760px;border:0';
      const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'";
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">` + page.html;
      const pipe = new MessageChannel();
      channel = pipe.port1;
      channel.onmessage = ({ data }) => pageCall(page, pipe, data);
      frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'fleet.init', theme: document.documentElement.dataset.theme, locale: document.documentElement.lang }, '*', [pipe.port2]), { once: true });
      panel.append(frame);
    } catch (error) { errorRow.textContent = error.message; }
  }
  new MutationObserver(() => {
    for (const { node, zh, en, property } of labels) node[property] = chinese() ? zh : en;
    if (channel) channel.postMessage({ type: 'fleet.settings', theme: document.documentElement.dataset.theme, locale: document.documentElement.lang });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
  update();
  plugins();
  setInterval(() => { if (!document.hidden) plugins(); }, 5000);
  setInterval(() => { if (!document.hidden) update(); }, 1000);
})();
