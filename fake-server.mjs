// A stand-in WebSocket for the tests, answering requests like an Apron server.

/** A stand-in for the global WebSocket that answers like an Apron server. */
export function fakeServer(answer) {
	const sockets = [];
	class FakeSocket {
		constructor(url) {
			this.url = url;
			this.sent = [];
			sockets.push(this);
			queueMicrotask(() => this.receive({ method: 'server', params: { apron: 9 } }));
		}
		receive(frame) {
			this.onmessage?.({ data: JSON.stringify(frame) });
		}
		send(data) {
			const frame = JSON.parse(data);
			this.sent.push(frame);
			queueMicrotask(() => this.receive({ id: frame.id, ...answer(frame) }));
		}
		close() {
			this.closed = true;
		}
	}
	return { FakeSocket, sockets };
}
