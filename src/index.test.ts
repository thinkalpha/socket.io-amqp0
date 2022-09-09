/* eslint-disable no-console */

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('source-map-support').install();

import { AmqpAdapterOptions, createAdapter, SidRoomRouting } from '.';
import io, { Socket } from 'socket.io';
import * as ioclient from 'socket.io-client';
import { randomString, delay } from './util';
import getPort from 'get-port';
import { connect } from 'amqplib';

let options: AmqpAdapterOptions;
let shutdownCallback: () => Promise<void>;
let readyPromise: Promise<void>;

beforeEach(() => {
    const testName = randomString();
    const endpointName = randomString();

    readyPromise = new Promise((res) => {
        options = {
            amqpConnection: async () => await connect('amqp://localhost', {}),
            sidRoomRouting: SidRoomRouting.normal,
            shutdownCallbackCallback: (cb) => (shutdownCallback = cb),
            readyCallback: res,
            exchangeName: randomString(),
        };
    });
});

let socket: io.Server;
let clients: ioclient.Socket[];

afterEach(async () => {
    clients?.map((client) => client.close());
    const closePromise = new Promise((res) => socket?.close(res));
    await closePromise;
    await shutdownCallback();
});

it('should forward a room-based message', async () => {
    const port = await getPort({});
    socket = new io.Server(port, {
        adapter: createAdapter({ ...options, name: 'should forward a room-based message' }),
    });
    const roomname = `room${randomString()}`;
    socket.on('connect', async (clientsock: Socket) => {
        await clientsock.join(roomname);
        socket.to(roomname).emit('testevent', 'asdf');
    });
    await readyPromise;
    clients = [ioclient.io(`http://localhost:${port}`, { autoConnect: true, transports: ['websocket'] })];
    const promise = new Promise((res, rej) => clients[0].on('testevent', (value: string) => res(value)));
    await promise;
    const res = await promise;
    expect(res).toBe('asdf');
});

it('should forward a multi-room message to all rooms', async () => {
    const port = await getPort({});
    socket = new io.Server(port, {
        adapter: createAdapter({ ...options, name: 'should forward a multi-room message to all rooms' }),
    });
    const roomname1 = `room${randomString()}`;
    const roomname2 = `room${randomString()}`;
    let firstConn = true;
    socket.on('connect', async (clientsock: Socket) => {
        if (firstConn) {
            firstConn = false;
            await clientsock.join(roomname1);
        } else {
            await clientsock.join(roomname2);
            socket.to([roomname1, roomname2]).emit('testevent', 'asdf');
        }
    });
    await readyPromise;
    async function doClient() {
        const client = ioclient.io(`http://localhost:${port}`, { autoConnect: true, transports: ['websocket'] });
        const promise = new Promise<string>((res, rej) => client.on('testevent', (value: string) => res(value)));
        return promise;
    }
    const [res] = await Promise.all([doClient(), doClient()]);
    expect(res).toBe('asdf');
});

it('should forward a non-room message', async () => {
    const port = await getPort({});
    socket = new io.Server(port, { adapter: createAdapter({ ...options, name: 'should forward a non-room message' }) });
    socket.on('connect', async (clientsock: Socket) => {
        socket.emit('testevent', 'asdf');
    });
    await readyPromise;
    clients = [ioclient.io(`http://localhost:${port}`, { autoConnect: true, transports: ['websocket'] })];
    const promise = new Promise((res, rej) => clients[0].on('testevent', (value: string) => res(value)));
    await promise;
    const res = await promise;
    expect(res).toBe('asdf');
});

it('should forward a direct-to-sid message', async () => {
    const port = await getPort({});
    socket = new io.Server(port, {
        adapter: createAdapter({ ...options, name: 'should forward a direct-to-sid message' }),
    });
    socket.on('connect', async (clientsock) => {
        clientsock.emit('testevent', 'asdf');
    });
    await readyPromise;
    clients = [ioclient.io(`http://localhost:${port}`, { autoConnect: true, transports: ['websocket'] })];
    const promise = new Promise((res, rej) => clients[0].on('testevent', (value: string) => res(value)));
    const res = await promise;
    expect(res).toBe('asdf');
});

it.skip('should gracefully handle a message to a room that DNE', async () => {
    const port = await getPort({});
    socket = new io.Server(port, {
        adapter: createAdapter({ ...options, name: 'should gracefully handle a message to a room that DNE' }),
    });
    const roomname = `room${randomString()}`;
    const didItPromise = new Promise((res, rej) => {
        socket.on('connect', async (clientsock) => {
            socket.to(roomname).emit('testevent', 'asdf');
            res(undefined);
        });
    });
    await readyPromise;
    clients = [ioclient.io(`http://localhost:${port}`, { autoConnect: true, transports: ['websocket'] })];
    await new Promise((res) => clients[0].on('connect', () => res(undefined)));
    await didItPromise;
});

// todo: this needs to be implemented
// it('should forward a binary message', async () => {
//     const port = await getPort({});
//     socket = new io.Server(port, { adapter: createAdapter(options) });
//     const sourceArr = [1, 234, -19];
//     const payload = {
//         stringPart: 'asdf',
//         binaryPart: new Uint16Array(sourceArr)
//     };
//     socket.on('connect', async clientsock => {
//         socket.emit('testbinevent', payload);
//     });
//     await readyPromise;
//     client = ioclient.io(`http://localhost:${port}`, {autoConnect: true, transports: ['websocket']});
//     const promise = new Promise((res, rej) => client.on('testbinevent', (value: string) => res(value)));
//     const res = await promise;
//     expect(res).toEqual(payload);
// });
