# socket.io-amqp0

[![Build Status](https://circleci.com/gh/thinkalpha/socket.io-amqp0.svg?style=svg)](https://circleci.com/gh/thinkalpha/socket.io-amqp0.svg?style=svg)
[![NPM version](https://badge.fury.io/js/socket.io-amqp0.svg)](http://badge.fury.io/js/socket.io-amqp0)

## Table of contents

- [How to use](#how-to-use)
- [How does it work under the hood?](#how-does-it-work-under-the-hood)
- [License](#license)

## How to use

```js
import { Server } from 'socket.io';
import { createAdapter } from 'socket.io-amqp0';
import { connect } from 'amqplib';

const io = new Server(3000);
io.adapter(createAdapter({ amqpConnection: () => connect('amqp://localhost') }));
```

By running Socket.IO with the `socket.io-amqp0` adapter you can run
multiple Socket.IO instances in different processes or servers that can
all broadcast and emit events to and from each other.

So any of the following commands:

```js
io.emit('hello', 'to all clients');
io.to('room42').emit('hello', "to all clients in 'room42' room");

io.on('connection', (socket) => {
  socket.broadcast.emit('hello', 'to all clients except sender');
  socket.to('room42').emit('hello', "to all clients in 'room42' room except sender");
});
```

will properly be broadcast to the clients through various AMQP exchanges/queues.

If you need to emit events to socket.io instances from a non-socket.io
process, you should use [socket.io-emitter](https://github.com/socketio/socket.io-emitter).

## How does it work under the hood?

This adapter extends the [in-memory adapter](https://github.com/socketio/socket.io-adapter/) that is included by default with the Socket.IO server.

The in-memory adapter stores the relationships between Sockets and Rooms in two Maps.

When you run `socket.join("room21")`, here's what happens:

```
console.log(adapter.rooms); // Map { "room21" => Set { "mdpk4kxF5CmhwfCdAHD8" } }
console.log(adapter.sids); // Map { "mdpk4kxF5CmhwfCdAHD8" => Set { "mdpk4kxF5CmhwfCdAHD8", "room21" } }
// "mdpk4kxF5CmhwfCdAHD8" being the ID of the given socket
```

Those two Maps are then used when broadcasting:

- a broadcast to all sockets (`io.emit()`) loops through the `sids` Map, and send the packet to all sockets
- a broadcast to a given room (`io.to("room21").emit()`) loops through the Set in the `rooms` Map, and sends the packet to all matching sockets

The AMQP adapter extends the broadcast function of the in-memory adapter: the packet is also published to an AMQP exchange with the same name as the room.

Each Socket.IO server that has at least one socket in the room receives this packet from its own queue bound to the exchange, and broadcasts it to its own list of connected sockets.

## License

ISC
