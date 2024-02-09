/* eslint-disable no-console */
import { BroadcastOptions, Room, SocketId, Adapter } from 'socket.io-adapter';
import { Namespace, Socket } from 'socket.io';
import { EventEmitter } from 'events';
import debugFactory, { Debugger } from 'debug';
import { Channel, ConfirmChannel, Connection } from 'amqplib';
import { hostname, networkInterfaces } from 'os';
import { randomString, mapIter, filterIter } from './util.js';
import { promisify } from 'util';

export const enum SidRoomRouting {
    normal = 'normal',
    local = 'local',
    banned = 'banned',
}

export interface AmqpAdapterOptions {
    amqpConnection: () => Promise<Connection> | Connection;
    sidRoomRouting?: SidRoomRouting;
    instanceName?: string;
    exchangeName?: string;
    queuePrefix?: string;

    shutdownCallbackCallback?: (callback: () => Promise<void>) => void;
    readyCallback?: () => void;
}

interface Envelope {
    packet: any;
    except?: SocketId[];
}

const nullSet = new Set<null>([null]);
Object.freeze(nullSet);

const emptySet = new Set<any>([]);
Object.freeze(emptySet);

const defaultRoomName = 'broadcast';
const defaultExchangeName = 'socket.io';

export const createAdapter = function ({ name, ...opts }: AmqpAdapterOptions & { name?: string }): typeof Adapter {
    const shim = class AmqpAdapterWrapper extends AmqpAdapter {
        constructor(nsp: Namespace) {
            super(nsp, opts, name ?? 'default');
        }
    };
    //    shim.name = AmqpAdapter.name;
    return shim;
};

export class AmqpAdapter extends Adapter {
    private debug: Debugger;
    readonly rooms: Map<Room, Set<SocketId>> = new Map();
    readonly sids: Map<SocketId, Set<Room>> = new Map();
    readonly instanceName: string;
    readonly exchangeName: string;
    readonly queuePrefix: string;
    private roomListeners: Map<Room | null, () => Promise<void>> = new Map();
    private closed = false;

    private consumeChannel!: Channel;
    private publishChannel!: ConfirmChannel;

    constructor(
        public readonly nsp: Namespace,
        private options: AmqpAdapterOptions,
        name: string,
    ) {
        super(nsp);
        this.debug = debugFactory(`socket.io-amqp:${name}`);
        this.instanceName = options.instanceName ?? hostname();
        this.exchangeName = options.exchangeName ?? defaultExchangeName;
        this.queuePrefix = options.queuePrefix ?? defaultExchangeName;

        options.shutdownCallbackCallback?.(async () => {
            this.debug('called shutdownCallback');
            this.closed = true;
            await Promise.all(mapIter(this.roomListeners.values(), (unsub) => unsub()));
        });
        this.init(); // hack until issue in socket.io is resolved
    }

    serverCount(): Promise<number> {
        return Promise.resolve(10);
    }

    async broadcastWithAck(
        packet: any,
        opts: BroadcastOptions,
        clientCountCallback: (clientCount: number) => void,
        ack: (...args: any[]) => void,
    ): Promise<void> {
        await this.broadcast(packet, opts);
        // todo: shim to handle broadcast with ack until I have time to implement it for real
        clientCountCallback(1);
        ack();
    }

    async handleConnection(conn: Connection) {
        conn.on('close', async () => {
            if (this.closed) return;
            this.debug('not closed, reopening');
            const conn = await this.options.amqpConnection();
            this.handleConnection(conn);
        });

        conn.on('error', (err) => {
            this.debug('Got connection error', err);
        });

        try {
            const [consumeChannel, publishChannel] = await Promise.all([
                conn.createChannel(),
                conn.createConfirmChannel(),
            ]);

            this.consumeChannel = consumeChannel;
            this.publishChannel = publishChannel;

            const promises: Promise<any>[] = [];
            for (const [room, shutdown] of this.roomListeners) {
                promises.push(shutdown());
                promises.push(this.setupRoom(room));
            }

            await Promise.all(promises);
        } catch (err) {
            if (this.closed) throw err;

            this.debug('Error in handleConnection', err);
            this.handleConnection(conn);
        }
    }

    async init(): Promise<void> {
        this.debug('start init w/ exchange name', this.exchangeName);

        // console.log('ohai', this.exchangeName);

        const connection = await this.options.amqpConnection();
        await this.handleConnection(connection);

        // set up the default broadcast
        await this.setupRoom(null);

        this.debug('end init');
        this.options.readyCallback?.();
    }

    async close(): Promise<void> {
        this.debug('Closing in Adapter', this.exchangeName);
        this.closed = true;
        await Promise.all(mapIter(this.roomListeners.values(), (unsub) => unsub()));
    }

    private async setupRoom(room: string | null): Promise<void> {
        if (this.closed) return;

        const queueName = await this.createRoomExchangeAndQueue(room);
        const unsub = await this.createRoomListener(room, queueName);
        this.roomListeners.set(room, unsub);
    }

    private localRouting: Set<string> = new Set();

    private async createQueueForRoom(room: string | null): Promise<string> {
        const queueName = `${this.queuePrefix}#${this.instanceName}${room ? `#${room}` : ''}`;
        await this.consumeChannel.assertQueue(queueName, {
            autoDelete: true,
            durable: false,
            arguments: {
                'x-expires': 1000 * 60,
            },
        });
        return queueName;
    }

    private async createRoomExchangeAndQueue(room: string | null): Promise<string> {
        const [, queueName] = await Promise.all([
            this.publishChannel.assertExchange(this.exchangeName, 'direct', {
                autoDelete: true,
                durable: false,
            }),
            this.createQueueForRoom(room),
        ]);

        this.debug('gonna bind', this.exchangeName, room ?? defaultRoomName);
        await this.consumeChannel.bindQueue(queueName, this.exchangeName, room ?? defaultRoomName);
        this.debug('did bind', this.exchangeName, room ?? defaultRoomName);
        return queueName;
    }

    private async handleIncomingMessage(envelope: Envelope, room: string | null) {
        const packet = envelope.packet;
        if (room && !this.rooms.has(room)) return;

        super.broadcast(packet, { except: new Set(envelope.except), rooms: room ? new Set([room]) : emptySet });
    }

    private async createRoomListener(room: string | null, queueName: string): Promise<() => Promise<void>> {
        this.debug('Starting room listener for', room);
        let consumerTag = randomString();

        const consumeReply = await this.consumeChannel.consume(
            queueName,
            async (msg) => {
                if (!msg) return;
                const payload = JSON.parse(msg.content.toString('utf8'));
                await this.handleIncomingMessage(payload, room);
                this.consumeChannel.ack(msg, false);
            },
            {
                noAck: false, // require manual ack
                consumerTag,
            },
        );
        consumerTag = consumeReply.consumerTag;

        return async () => {
            this.debug('Canceling room listener for', room, `(${this.exchangeName})`);
            await this.consumeChannel.cancel(consumerTag);
        };
    }

    async addAll(id: string, rooms: Set<string>): Promise<void> {
        // eslint-disable-next-line prefer-rest-params
        this.debug('addAll', ...arguments);

        const newRooms = new Set<string>();
        for (const room of rooms) {
            if (room === id) {
                if (this.options.sidRoomRouting === SidRoomRouting.banned) continue;
                if (this.options.sidRoomRouting === SidRoomRouting.local) {
                    this.localRouting.add(room);
                    continue;
                }
            }
            if (!this.sids.has(id)) {
                this.sids.set(id, new Set());
            }
            this.sids.get(id)!.add(room);

            if (!this.rooms.has(room)) {
                this.rooms.set(room, new Set());
                newRooms.add(room);
            }
            this.rooms.get(room)!.add(id);
        }

        await Promise.all([
            ...mapIter(newRooms, async (room) => {
                const queueName = await this.createRoomExchangeAndQueue(room);
                const unsub = await this.createRoomListener(room, queueName);
                this.roomListeners.set(room, unsub);
            }),
        ]);
    }

    del(id: string, room: string): void {
        if (this.sids.has(id)) {
            this.sids.get(id)!.delete(room);
        }

        if (this.rooms.has(room)) {
            this.rooms.get(room)!.delete(id);
            if (this.rooms.get(room)!.size === 0) {
                this.rooms.delete(room);
                this.debug('called del on room:', room);
                // tear down the room listener
                this.roomListeners.get(room)?.();
                this.roomListeners.delete(room);
            }
        }
    }
    delAll(id: string): void {
        this.localRouting.delete(id);

        if (!this.sids.has(id)) {
            return;
        }

        for (const room of this.sids.get(id)!) {
            this.del(id, room); // todo: probably wrap this via promises
        }

        this.sids.delete(id);
    }

    private async publishToRooms(rooms: (string | null)[], envelope: Envelope) {
        this.debug('Publishing message for rooms', rooms, envelope);

        const routeKeys = rooms.map((room) => room ?? defaultRoomName);

        const buffer = Buffer.from(JSON.stringify(envelope));
        await promisify(this.publishChannel.publish).bind(this.publishChannel)(
            this.exchangeName,
            routeKeys[0],
            buffer,
            { ...(routeKeys.length > 1 ? { CC: routeKeys.slice(1) } : {}) },
        );
    }

    async broadcast(packet: any, opts: BroadcastOptions): Promise<void> {
        this.debug('broadcast', packet, opts);
        if (opts.flags?.local) {
            return super.broadcast(packet, opts);
        }
        const envelope: Envelope = {
            packet,
            except: opts.except && [...opts.except],
        };
        const rooms = opts.rooms && opts.rooms.size ? opts.rooms : nullSet;
        const nonlocalRooms = [...filterIter(rooms, (room) => !this.localRouting.has(room!))];
        await Promise.all([
            ...mapIter(
                filterIter(rooms, (room) => this.localRouting.has(room!)),
                async (room) => {
                    await this.broadcast(packet, {
                        ...opts,
                        rooms: new Set([room!]),
                        flags: { ...opts.flags, local: true },
                    });
                },
            ),
            this.publishToRooms(nonlocalRooms, envelope),
        ]);
    }

    sockets(rooms: Set<Room>, callback?: (sockets: Set<SocketId>) => void): Promise<Set<SocketId>> {
        const sids = new Set<SocketId>();

        if (rooms.size) {
            for (const room of rooms) {
                if (!this.rooms.has(room)) continue;

                for (const id of this.rooms.get(room)!) {
                    if (id in this.nsp.sockets) {
                        sids.add(id);
                    }
                }
            }
        } else {
            for (const [id] of this.sids) {
                if (id in this.nsp.sockets) sids.add(id);
            }
        }

        callback?.(sids);
        return Promise.resolve(sids);
    }

    socketRooms(id: string): Set<Room> | undefined {
        return this.sids.get(id);
    }

    serverSideEmit(packet: any[]): void {
        throw new Error('this adapter does not support the serverSideEmit() functionality');
    }

    onPublishChannelErrorCallback = (callback: (err: Error) => void) => {
        this.publishChannel.on('error', callback);
    }

    onConsumeChannelErrorCallback = (callback: (err: Error) => void) => {
        this.consumeChannel.on('error', callback);
    }
}
