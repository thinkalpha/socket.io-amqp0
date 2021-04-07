export function* mapIter<T, U>(iterable: Iterable<T>, proj: (item: T) => U): Iterable<U> {
    for (const x of iterable) {
        yield proj(x);
    }
}

export function* filterIter<T>(iterable: Iterable<T>, pred: (item: T) => boolean): Iterable<T> {
    for (const x of iterable) {
        if (pred(x)) yield x;
    }
}

export function randomString(length = 8) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return text;
}

export function delay(ms: number): Promise<void> {
    return new Promise((res, rej) => setTimeout(res, ms));
}
