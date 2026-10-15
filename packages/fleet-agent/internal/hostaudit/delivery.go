package hostaudit

import (
	"sync"
	"sync/atomic"
)

// Delivery bounds metadata backlog and keeps storage latency out of the ptrace
// lifetime. An unresponsive sink can retain one writer goroutine, never the
// collector or workload. Stop drains a bounded backlog into the same captured store, then final
// health, if the sink recovers. No caller waits for this best-effort persistence.
type delivery struct {
	events  chan Event
	health  chan Event
	stop    chan struct{}
	once    sync.Once
	stopped atomic.Bool
	sink    Sink
	failure func()
}

func newDelivery(sink Sink, failure func()) *delivery {
	d := &delivery{events: make(chan Event, 256), health: make(chan Event, 1), stop: make(chan struct{}), sink: sink, failure: failure}
	go d.run()
	return d
}
func (d *delivery) offer(e Event) bool {
	if d.stopped.Load() {
		return true
	} // The recorded stopped scope owns this loss.
	select {
	case d.events <- e:
		return true
	default:
		return false
	}
}
func (d *delivery) report(e Event) {
	select {
	case d.health <- e:
	default:
		select {
		case <-d.health:
		default:
		}
		select {
		case d.health <- e:
		default:
		}
	}
}
func (d *delivery) close() { d.once.Do(func() { d.stopped.Store(true); close(d.stop) }) }
func (d *delivery) send(e Event) {
	if d.sink(e) != nil && d.failure != nil {
		d.failure()
	}
}
func (d *delivery) run() {
	for {
		if d.stopped.Load() {
			for {
				select {
				case e := <-d.events:
					d.send(e)
					continue
				default:
				}
				break
			}
			select {
			case e := <-d.health:
				d.send(e)
			default:
			}
			return
		}
		select {
		case <-d.stop:
			continue
		case e := <-d.health:
			d.send(e)
		case e := <-d.events:
			if !d.stopped.Load() {
				d.send(e)
			}
		}
	}
}
