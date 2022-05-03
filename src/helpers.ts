import * as path from "path";
import * as fs from "fs";
import { platform } from "process";
import sharp from "sharp";
import { toIco } from "./ico";
import { FaviconImage } from "./index";
import { IconOptions } from "./config/defaults";
import { svgDensity } from "./svgtool";

export type Dictionary<T> = { [key: string]: T };

export type SourceImage = { data: Buffer; metadata: sharp.Metadata };

export type RawImage = { data: Buffer; info: sharp.OutputInfo };

export interface IconPlaneOptions {
  readonly width: number;
  readonly height: number;
  readonly offset?: number;
  readonly pixelArt: boolean;
  readonly background?: string;
  readonly transparent: boolean;
  readonly rotate: boolean;
}

function arrayComparator(a: unknown, b: unknown): number {
  const aArr = [a].flat(Infinity);
  const bArr = [b].flat(Infinity);

  for (let i = 0; i < Math.max(aArr.length, bArr.length); ++i) {
    if (i >= aArr.length) return -1;
    if (i >= bArr.length) return 1;
    if (aArr[i] !== bArr[i]) {
      return aArr[i] < bArr[i] ? -1 : 1;
    }
  }
  return 0;
}

function minBy<T>(array: T[], comparator: (a: T, b: T) => number): T {
  return array.reduce((acc, cur) => (comparator(acc, cur) < 0 ? acc : cur));
}

function minByKey<T>(array: T[], keyFn: (e: T) => unknown) {
  return minBy(array, (a, b) => arrayComparator(keyFn(a), keyFn(b)));
}

export function mapValues<T, U>(
  dict: Dictionary<T>,
  mapper: (value: T, key: string) => U
): Dictionary<U> {
  return Object.fromEntries(
    Object.entries(dict).map(([key, value]) => [key, mapper(value, key)])
  );
}

export function filterKeys<T>(
  dict: Dictionary<T>,
  predicate: (key: string) => boolean
): Dictionary<T> {
  return Object.fromEntries(
    Object.entries(dict).filter((pair) => predicate(pair[0]))
  );
}

export function asString(arg: unknown): string | undefined {
  return typeof arg === "string" || arg instanceof String
    ? arg.toString()
    : undefined;
}

export async function sourceImages(
  src: string | string[] | Buffer | Buffer[]
): Promise<SourceImage[]> {
  if (Buffer.isBuffer(src)) {
    try {
      return [
        {
          data: src,
          metadata: await sharp(src).metadata(),
        },
      ];
    } catch (error) {
      return Promise.reject(new Error("Invalid image buffer"));
    }
  } else if (typeof src === "string") {
    const buffer = await fs.promises.readFile(src);

    return await sourceImages(buffer);
  } else if (Array.isArray(src) && !src.some(Array.isArray)) {
    if (!src.length) {
      throw new Error("No source provided");
    }
    const images = await mapAsync(src, sourceImages);

    return images.flat();
  } else {
    throw new Error("Invalid source type provided");
  }
}

function flattenIconOptions(iconOptions: IconOptions): IconPlaneOptions[] {
  return iconOptions.sizes.map((size) => ({
    ...size,
    offset: iconOptions.offset ?? 0,
    pixelArt: iconOptions.pixelArt ?? false,
    background: asString(iconOptions.background),
    transparent: iconOptions.transparent,
    rotate: iconOptions.rotate,
  }));
}

export function relativeTo(
  base: string | undefined | null,
  path: string
): string {
  if (!base) {
    return path;
  }

  const directory = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(path, new URL(directory, "resolve://"));

  return url.protocol === "resolve:" ? url.pathname : url.toString();
}

export class Images {
  bestSource(
    sourceset: SourceImage[],
    width: number,
    height: number
  ): SourceImage {
    const sideSize = Math.max(width, height);
    return minByKey(sourceset, (icon) => {
      const iconSideSize = Math.max(icon.metadata.width, icon.metadata.height);
      return [
        icon.metadata.format === "svg" ? 0 : 1, // prefer SVG
        iconSideSize >= sideSize ? 0 : 1, // prefer downscale
        Math.abs(iconSideSize - sideSize), // prefer closest size
      ];
    });
  }

  async resize(
    source: SourceImage,
    width: number,
    height: number,
    pixelArt: boolean
  ): Promise<Buffer> {
    if (source.metadata.format === "svg") {
      const options = {
        density: svgDensity(source.metadata, width, height),
      };
      return await sharp(source.data, options)
        .resize({
          width,
          height,
          fit: sharp.fit.contain,
          background: "#00000000",
        })
        .toBuffer();
    }

    return await sharp(source.data)
      .ensureAlpha()
      .resize({
        width,
        height,
        fit: sharp.fit.contain,
        background: "#00000000",
        kernel:
          pixelArt &&
          width >= source.metadata.width &&
          height >= source.metadata.height
            ? "nearest"
            : "lanczos3",
      })
      .toBuffer();
  }

  createBlankImage(
    width: number,
    height: number,
    background?: string
  ): sharp.Sharp {
    const transparent = !background || background === "transparent";

    let image = sharp({
      create: {
        width,
        height,
        channels: transparent ? 4 : 3,
        background: transparent ? "#00000000" : background,
      },
    });

    if (transparent) {
      image = image.ensureAlpha();
    }
    return image;
  }

  async createPlaneFavicon(
    sourceset: SourceImage[],
    options: IconPlaneOptions,
    name: string,
    raw = false
  ): Promise<FaviconImage> {
    const offset =
      Math.round(
        (Math.max(options.width, options.height) * options.offset) / 100
      ) || 0;
    const width = options.width - offset * 2;
    const height = options.height - offset * 2;

    const source = this.bestSource(sourceset, width, height);
    const image = await this.resize(source, width, height, options.pixelArt);

    let pipeline = this.createBlankImage(
      options.width,
      options.height,
      options.background
    ).composite([{ input: image, left: offset, top: offset }]);

    if (options.rotate) {
      const degrees = 90;
      pipeline = pipeline.rotate(degrees);
    }

    const contents = raw
      ? await pipeline
          .toColorspace("srgb")
          .raw({ depth: "uchar" })
          .toBuffer({ resolveWithObject: true })
      : await pipeline.png().toBuffer();

    return { name, contents };
  }

  async createFavicon(
    sourceset: SourceImage[],
    name: string,
    iconOptions: IconOptions
  ): Promise<FaviconImage> {
    const properties = flattenIconOptions(iconOptions);

    if (path.extname(name) === ".ico" || properties.length !== 1) {
      const images = await mapAsync(properties, (props) =>
        this.createPlaneFavicon(
          sourceset,
          props,
          `${props.width}x${props.height}.rawdata`,
          true
        )
      );
      const contents = toIco(images.map((image) => image.contents as RawImage));

      return {
        name,
        contents,
      };
    }

    return await this.createPlaneFavicon(sourceset, properties[0], name, false);
  }
}

export async function mapAsync<T, U>(
  inputs: T[],
  computation: (input: T, index: number) => Promise<U>
): Promise<U[]> {
  if (platform === "win32") {
    // run sequentially
    const result: U[] = [];
    let index = 0;
    for (const input of inputs) {
      result.push(await computation(input, index));
      index++;
    }
    return result;
  } else {
    return await Promise.all(inputs.map(computation));
  }
}
