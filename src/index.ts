/* eslint-disable no-console */
import { BroadcastOptions, Room, SocketId, Adapter } from 'socket.io-adapter';
import { Namespace, Socket } from 'socket.io';
import { EventEmitter } from 'events';
import debugFactory from 'debug';
import { Channel, ConfirmChannel, Connection } from 'amqplib';
import { hostname, networkInterfaces } from 'os';
import { randomString, mapIter, filterIter } from './util';
import { promisify } from 'util';

const debug = debugFactory('socket.io-amqp');

export enum SidRoomRouting {
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

export const createAdapter = function (opts: AmqpAdapterOptions): typeof Adapter {
    const shim = class AmqpAdapterWrapper extends AmqpAdapter {
        constructor(nsp: Namespace) {
            super(nsp, opts);
        }
    };
    //    shim.name = AmqpAdapter.name;
    return shim;
};

export class AmqpAdapter extends Adapter {
    readonly rooms: Map<Room, Set<SocketId>> = new Map();
    readonly sids: Map<SocketId, Set<Room>> = new Map();
    readonly instanceName: string;
    readonly exchangeName: string;
    readonly queuePrefix: string;
    private roomListeners: Map<Room | null, () => Promise<void>> = new Map();
    private closed = false;

    private consumeChannel!: Channel;
    private publishChannel!: ConfirmChannel;

    constructor(public readonly nsp: Namespace, private options: AmqpAdapterOptions) {
        super(nsp);
        this.instanceName = options.instanceName ?? hostname();
        this.exchangeName = options.exchangeName ?? defaultExchangeName;
        this.queuePrefix = options.queuePrefix ?? defaultExchangeName;

        options.shutdownCallbackCallback?.(async () => {
            await Promise.all(mapIter(this.roomListeners.values(), (unsub) => unsub()));
        });
        this.init(); // hack until issue in socket.io is resolved
    }

    async handleConnection(conn: Connection) {
        conn.on('close', async () => {
            if (this.closed) return;
            const conn = await this.options.amqpConnection();
            this.handleConnection(conn);
        });

        conn.on('error', (err) => {
            debug('Got connection error', err);
        });

        const [consumeChannel, publishChannel] = await Promise.all([conn.createChannel(), conn.createConfirmChannel()]);

        this.consumeChannel = consumeChannel;
        this.publishChannel = publishChannel;

        const promises: Promise<any>[] = [];
        for (const [room, shutdown] of this.roomListeners) {
            promises.push(shutdown());
            promises.push(this.setupRoom(room));
        }
    }

    async init(): Promise<void> {
        debug('start init');

        // console.log('ohai', this.exchangeName);

        const connection = await this.options.amqpConnection();
        await this.handleConnection(connection);

        // set up the default broadcast
        await this.setupRoom(null);

        debug('end init');
        this.options.readyCallback?.();
    }

    async close(): Promise<void> {
        this.closed = true;
        await Promise.all(mapIter(this.roomListeners.values(), (unsub) => unsub()));
    }

    private async setupRoom(room: string | null): Promise<void> {
        const queueName = await this.createRoomExchangeAndQueue(room);
        const unsub = this.createRoomListener(room, queueName);
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

        // console.log('gonna bind', this.exchangeName, room ?? defaultRoomName);
        await this.consumeChannel.bindQueue(queueName, this.exchangeName, room ?? defaultRoomName);
        // console.log('did bind', this.exchangeName, room ?? defaultRoomName);
        return queueName;
    }

    private async handleIncomingMessage(envelope: Envelope, room: string | null) {
        const packet = envelope.packet;
        if (room && !this.rooms.has(room)) return;

        super.broadcast(packet, { except: new Set(envelope.except), rooms: room ? new Set([room]) : emptySet });
    }

    private createRoomListener(room: string | null, queueName: string): () => Promise<void> {
        debug('Starting room listener for', room);
        let consumerTag = randomString();

        this.consumeChannel
            .consume(
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
            )
            .then((x) => (consumerTag = x.consumerTag));

        return async () => {
            debug('Canceling room listener for', room);
            await this.consumeChannel.cancel(consumerTag);
        };
    }

    async addAll(id: string, rooms: Set<string>): Promise<void> {
        // eslint-disable-next-line prefer-rest-params
        debug('addAll', ...arguments);

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
                const unsub = this.createRoomListener(room, queueName);
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
        debug('Publishing message for rooms', rooms, envelope);

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
        debug('broadcast', packet, opts);
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
}
