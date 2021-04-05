/* eslint-disable no-console */
import { BroadcastOptions, Room, SocketId, Adapter } from 'socket.io-adapter';
import { Namespace, Socket } from 'socket.io';
import { EventEmitter } from 'events';
import debugFactory from 'debug';
import { Channel, ConfirmChannel, Connection } from 'amqplib';
import { hostname, networkInterfaces } from 'os';
import { randomString, mapIter } from './util';
import {promisify} from 'util';

const debug = debugFactory('socket.io-amqp');

export enum SidRoomRouting {
    normal = 'normal',
    local = 'local',
    banned = 'banned',
}

export interface AmqpAdapterOptions {
    amqpConnection: () => (Promise<Connection> | Connection);
    sidRoomRouting?: SidRoomRouting;
    instanceName?: string;

    shutdownCallbackCallback?: (callback: () => Promise<void>) => void;
    readyCallback?: () => void;
}

interface Envelope {
    packet: any;
    except?: SocketId[];
}

type OmitFirstArg<F> = F extends (x: any, ...args: infer P) => infer R ? (...args: P) => R : never;

const nullSet = new Set<null>([null]);
Object.freeze(nullSet);

const emptySet = new Set<any>([]);
Object.freeze(emptySet);

const defaultRoomName = 'default';

export const createAdapter = function (opts: AmqpAdapterOptions): typeof AmqpAdapter {
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

    private consumeChannel!: Channel;
    private publishChannel!: ConfirmChannel;

    constructor(public readonly nsp: Namespace, private options: AmqpAdapterOptions) {
        super(nsp);
        this.instanceName = options.instanceName ?? hostname();

        options.shutdownCallbackCallback?.(async () => { await Promise.all(mapIter(this.roomListeners.values(), unsub => unsub())); });
        this.init(); // hack until issue in socket.io is resolved
    }

    async init(): Promise<void> {
        debug('start init');

        const connection = await this.options.amqpConnection();
        const [consumeChannel, publishChannel] = await Promise.all([
            connection.createChannel(),
            connection.createConfirmChannel(),
        ]);

        this.consumeChannel = consumeChannel;
        this.publishChannel = publishChannel;

        // set up the default broadcast
        const queueName = await this.createRoomSnsAndSqs(null);
        const unsub = this.createRoomListener(null, queueName);
        this.roomListeners.set(null, unsub);

        debug('end init');
        this.options.readyCallback?.();
    }

    async close(): Promise<void> {
        await Promise.all(mapIter(this.roomListeners.values(), (unsub) => unsub()));
    }

    private roomListeners: Map<Room | null, () => Promise<void>> = new Map();

    private localRouting: Set<string> = new Set();

    private async createQueueForRoom(room: string | null): Promise<string> {
        const queueName = `${this.instanceName}${room ? `#${room}` : ''}`;
        await this.consumeChannel.assertQueue(queueName, {
            autoDelete: true,
            durable: false,
        });
        return queueName;
    }

    private async createRoomSnsAndSqs(room: string | null): Promise<string> {
        const exchangeName = room ?? defaultRoomName;
        const [, queueName] = await Promise.all([
            this.publishChannel.assertExchange(exchangeName, 'fanout', {
                autoDelete: true,
                durable: false,
            }),
            this.createQueueForRoom(room),
        ]);

        await this.consumeChannel.bindQueue(queueName, exchangeName, '*');
        return queueName;
    }

    private async handleMessage(envelope: Envelope, room: string | null) {
        const sids = room ? this.rooms.get(room)! : this.nsp.sockets.keys();
        const excepts = new Set(envelope.except);
        const packet = envelope.packet;
        for (const sid of sids) {
            if (excepts.has(sid)) continue;

            super.broadcast(packet, { rooms: room ? new Set([room]) : emptySet });
        }
    }

    private createRoomListener(room: string | null, queueName: string): () => Promise<void> {
        debug('Starting room listener for', room);
        const consumerTag = randomString();

        this.consumeChannel.consume(
            queueName,
            async (msg) => {
                if (!msg) return;
                const payload = JSON.parse(msg.content.toString('utf8'));
                await this.handleMessage(payload, room);
            },
            {
                noAck: false, // require manual ack
                consumerTag,
            },
        );

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
                const queueName = await this.createRoomSnsAndSqs(room);
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
        await Promise.all([
            ...mapIter(rooms, async (room) => {
                if (this.localRouting.has(room!)) {
                    await this.broadcast(packet, {
                        ...opts,
                        rooms: new Set([room!]),
                        flags: { ...opts.flags, local: true },
                    });
                } else {
                    const exchangeName = room ?? defaultRoomName;
                    debug('Publishing message for room', room, envelope);

                    const buffer = Buffer.from(JSON.stringify(envelope));
                    await promisify(this.publishChannel.publish).bind(this.publishChannel)(exchangeName, '*', buffer, {});
                }
            }),
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
}
