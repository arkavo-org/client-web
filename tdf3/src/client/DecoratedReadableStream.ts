import streamSaver from 'streamsaver';
import { fileSave } from 'browser-fs-access';
import { isFirefox } from '../../../src/utils.js';
import { type Metadata } from '../tdf.js';
import { type Manifest, type UpsertResponse } from '../models/index.js';

export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const accumulator = await new Response(stream).arrayBuffer();
  return new Uint8Array(accumulator);
}

export type DecoratedReadableStreamSinkOptions = {
  encoding?: BufferEncoding;
  signal?: AbortSignal;
};

export class DecoratedReadableStream {
  KEK: null | string | undefined;
  algorithm: string | undefined;
  policyUuid?: string;
  tdfSize: number | undefined;
  fileSize: number | undefined;
  stream: ReadableStream<Uint8Array>;
  metadata?: Metadata;
  contentLength?: number;
  manifest: Manifest | undefined;
  upsertResponse?: UpsertResponse;
  fileStreamServiceWorker?: string;

  constructor(
    underlyingSource: UnderlyingSource & {
      fileStreamServiceWorker?: string;
    }
  ) {
    if (underlyingSource.fileStreamServiceWorker) {
      this.fileStreamServiceWorker = underlyingSource.fileStreamServiceWorker;
    }
    this.stream = new ReadableStream(underlyingSource, {
      highWaterMark: 1,
    }) as ReadableStream<Uint8Array>;
  }
  /**
   * Dump the stream content to a string. This will consume the stream.
   * @return the plaintext in string form.
   */
  async toString(): Promise<string> {
    return new Response(this.stream).text();
  }

  /**
   * Dump the stream content to a local file. This will consume the stream.
   *
   * @param filepath The path of the local file to write plaintext to.
   * @param options
   */
  async toFile(
    filepath = 'download.tdf',
    options?: BufferEncoding | DecoratedReadableStreamSinkOptions
  ): Promise<void> {
    if (options && typeof options === 'string') {
      throw new Error('Unsupported Operation: Cannot set encoding in browser');
    }
    if (isFirefox()) {
      await fileSave(new Response(this.stream), {
        fileName: filepath,
        extensions: [`.${filepath.split('.').pop()}`],
      });
      return;
    }

    if (this.fileStreamServiceWorker) {
      streamSaver.mitm = this.fileStreamServiceWorker;
    }

    const fileStream = streamSaver.createWriteStream(filepath, {
      ...(this.contentLength && { size: this.contentLength }),
      writableStrategy: { highWaterMark: 1 },
      readableStrategy: { highWaterMark: 1 },
    });

    if (WritableStream) {
      return this.stream.pipeTo(fileStream, options);
    }

    // Write (pipe) manually
    const reader = this.stream.getReader();
    const writer = fileStream.getWriter();
    const pump = async (): Promise<void> => {
      const res = await reader.read();

      if (res.done) {
        return await writer.close();
      } else {
        await writer.write(res.value);
        return pump();
      }
    };
    return pump();

    // const pump = (): Promise<void> =>
    //   reader.read().then((res) => (res.done ? writer.close() : writer.write(res.value).then(pump)));
    // pump();
  }
}

export function isDecoratedReadableStream(s: unknown): s is DecoratedReadableStream {
  return (
    typeof (s as DecoratedReadableStream)?.toFile !== 'undefined' &&
    typeof (s as DecoratedReadableStream)?.toString !== 'undefined'
  );
}
