import { Accessor, AnimationChannel, AnimationSampler, AttributeLink, Buffer, BufferUtils, Document, Extension, GLB_BUFFER, GLTF, IndexLink, Primitive, PropertyType, ReaderContext, TypedArray, WriterContext } from '@gltf-transform/core';
import { EXT_MESHOPT_COMPRESSION } from '../constants';
import type { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { MeshoptDecoder as decoder } from 'meshoptimizer'; // TODO(cleanup): Remove after debugging...

const NAME = EXT_MESHOPT_COMPRESSION;

enum MeshoptMode {
	ATTRIBUTES = 'ATTRIBUTES',
	TRIANGLES = 'TRIANGLES',
	INDICES = 'INDICES',
}

enum MeshoptFilter {
	NONE = 'NONE',
	OCTAHEDRAL = 'OCTAHEDRAL',
	QUATERNION = 'QUATERNION',
	EXPONENTIAL = 'EXPONENTIAL',
}

interface MeshoptBufferExtension {
	fallback?: boolean;
}

interface MeshoptBufferViewExtension {
	buffer: number;
	byteOffset: number;
	byteLength: number;
	byteStride: number;
	count: number;
	mode: MeshoptMode;
	filter?: MeshoptFilter;
}

export const BufferViewTarget = {
	ARRAY_BUFFER: 34962,
	ELEMENT_ARRAY_BUFFER: 34963
};

enum EncoderMethod {
	QUANTIZE = 'quantize',
	FILTER = 'filter',
}

interface EncoderOptions {
	method?: EncoderMethod,
	// bits...
}

const DEFAULT_ENCODER_OPTIONS: Required<EncoderOptions> = {
	method: EncoderMethod.QUANTIZE
};

type MeshoptBufferView = {extensions: {[NAME]: MeshoptBufferViewExtension}};
type EncodedBufferView = GLTF.IBufferView & MeshoptBufferView;

/**
 * # MeshoptCompression
 *
 * [`EXT_meshopt_compression`](https://github.com/KhronosGroup/glTF/blob/master/extensions/2.0/Vendor/EXT_meshopt_compression/)
 * provides compression and fast decoding for geometry, morph targets, and animations.
 *
 * [[include:VENDOR_EXTENSIONS_NOTE.md]]
 *
 * Meshopt compression (based on the [meshoptimizer](https://github.com/zeux/meshoptimizer)
 * library) offers a lightweight decoder with very fast runtime decompression, and is
 * appropriate for models of any size. Meshopt can reduce the transmission sizes of geometry,
 * morph targets, animation, and other numeric data stored in buffer views. When textures are
 * large, other complementary compression methods should be used as well.
 *
 * For the full benefits of meshopt compression, **apply gzip, brotli, or another lossless
 * compression method** to the resulting .glb, .gltf, or .bin files. Meshopt specifically
 * pre-optimizes assets for this purpose — without this secondary compression, the size
 * reduction is considerably less.
 *
 * Be aware that decompression happens before uploading to the GPU. While Meshopt decoding is
 * considerably faster than Draco decoding, neither compression method will improve runtime
 * performance directly. To improve framerate, you'll need to simplify the geometry by reducing
 * vertex count or draw calls — not just compress it. Finally, be aware that Meshopt compression is
 * lossy: repeatedly compressing and decompressing a model in a pipeline will lose precision, so
 * compression should generally be the last stage of an art workflow, and uncompressed original
 * files should be kept.
 *
 * A [meshopt decoder](https://github.com/zeux/meshoptimizer/tree/master/js) is required for reading
 * files, and must be provided by the application. Encoding/compression is not yet supported, but
 * can be applied with the [gltfpack](https://github.com/zeux/meshoptimizer/tree/master/gltf) tool.
 *
 * ### Example
 *
 * ```typescript
 * import { NodeIO } from '@gltf-transform/core';
 * import { MeshoptCompression } from '@gltf-transform/extensions';
 * import { MeshoptDecoder } from 'meshoptimizer';
 *
 * await MeshoptDecoder.ready;
 *
 * const io = new NodeIO()
 *	.registerExtensions([MeshoptCompression])
 *	.registerDependencies({'meshopt.decoder': MeshoptDecoder});
 *
 * // Read and decode.
 * const doc = io.read('compressed.glb');
 * ```
 */
export class MeshoptCompression extends Extension {
	public readonly extensionName = NAME;
	public readonly prereadTypes = [PropertyType.BUFFER, PropertyType.PRIMITIVE];
	public readonly prewriteTypes = [PropertyType.BUFFER, PropertyType.ACCESSOR];
	public readonly readDependencies = ['meshopt.decoder'];
	public readonly writeDependencies = ['meshopt.encoder'];

	public static readonly EXTENSION_NAME = NAME;
	public static readonly EncoderMethod = EncoderMethod;

	private _decoder: typeof MeshoptDecoder | null = null;
	private _decoderFallbackBufferMap = new Map<Buffer, Buffer>();
	private _encoder: typeof MeshoptEncoder | null = null;
	private _encoderOptions: Required<EncoderOptions> = DEFAULT_ENCODER_OPTIONS;
	private _encoderFallbackBuffer: Buffer | null = null;
	private _encoderBufferViews: {[key: string]: EncodedBufferView} = {};
	private _encoderBufferViewData: {[key: string]: ArrayBuffer[]} = {};
	private _encoderBufferViewAccessors: {[key: string]: GLTF.IAccessor[]} = {};

	public install(key: string, dependency: unknown): this {
		if (key === 'meshopt.decoder') {
			this._decoder = dependency as typeof MeshoptDecoder;
		}
		if (key === 'meshopt.encoder') {
			this._encoder = dependency as typeof MeshoptEncoder;
		}
		return this;
	}


	public setEncoderOptions(options: EncoderOptions): this {
		this._encoderOptions = {...DEFAULT_ENCODER_OPTIONS, ...options};
		return this;
	}

	public preread(context: ReaderContext, propertyType: PropertyType): this {
		if (!this._decoder) {
			if (!this.isRequired()) return this;
			throw new Error(`[${NAME}] Please install extension dependency, "meshopt.decoder".`);
		}
		if (!this._decoder.supported) {
			if (!this.isRequired()) return this;
			throw new Error(`[${NAME}]: Missing WASM support.`);
		}

		if (propertyType === PropertyType.BUFFER) {
			this._prereadBuffers(context);
		} else if (propertyType === PropertyType.PRIMITIVE) {
			this._prereadPrimitives(context);
		}

		return this;
	}

	/** @internal Decode buffer views. */
	private _prereadBuffers(context: ReaderContext): void {
		const jsonDoc = context.jsonDoc;

		const viewDefs = jsonDoc.json.bufferViews || [];
		viewDefs.forEach((viewDef, index) => {
			if (!viewDef.extensions || !viewDef.extensions[NAME]) return;

			const meshoptDef = viewDef.extensions[NAME] as MeshoptBufferViewExtension;
			const byteOffset = meshoptDef.byteOffset || 0;
			const byteLength = meshoptDef.byteLength || 0;
			const count = meshoptDef.count;
			const stride = meshoptDef.byteStride;
			const result = new Uint8Array(new ArrayBuffer(count * stride));

			const bufferDef = jsonDoc.json.buffers![viewDef.buffer];
			const resource = bufferDef.uri
				? jsonDoc.resources[bufferDef.uri]
				: jsonDoc.resources[GLB_BUFFER];
			const source = new Uint8Array(resource, byteOffset, byteLength);

			this._decoder!.decodeGltfBuffer(
				result, count, stride, source, meshoptDef.mode, meshoptDef.filter
			);

			context.bufferViews[index] = result;
		});
	}

	/**
	 * Mark fallback buffers and replacements.
	 *
	 * Note: Alignment with primitives is arbitrary; this just needs to happen
	 * after Buffers have been parsed.
	 * @internal
	 */
	private _prereadPrimitives(context: ReaderContext): void {
		const jsonDoc = context.jsonDoc;
		const viewDefs = jsonDoc.json.bufferViews || [];

		//
		viewDefs.forEach((viewDef) => {
			if (!viewDef.extensions || !viewDef.extensions[NAME]) return;

			const meshoptDef = viewDef.extensions[NAME] as MeshoptBufferViewExtension;

			const buffer = context.buffers[meshoptDef.buffer];
			const fallbackBuffer = context.buffers[viewDef.buffer];
			const fallbackBufferDef = jsonDoc.json.buffers![viewDef.buffer];
			if (isFallbackBuffer(fallbackBufferDef)) {
				this._decoderFallbackBufferMap.set(fallbackBuffer, buffer);
			}
		});
	}

	public read(_context: ReaderContext): this {
		if (!this.isRequired()) return this;

		// Replace fallback buffers.
		for (const [fallbackBuffer, buffer] of this._decoderFallbackBufferMap) {
			for (const parent of fallbackBuffer.listParents()) {
				if (parent instanceof Accessor) {
					parent.swap(fallbackBuffer, buffer);
				}
			}
			fallbackBuffer.dispose();
		}

		return this;
	}

	public prewrite(context: WriterContext, propertyType: PropertyType): this {
		if (propertyType === PropertyType.ACCESSOR) {
			this._prewriteAccessors(context);
		} else if (propertyType === PropertyType.BUFFER) {
			this._prewriteBuffers(context);
		}
		return this;
	}

	private _prewriteAccessors(context: WriterContext): void {
		const json = context.jsonDoc.json;
		const encoder = this._encoder!;
		const options = this._encoderOptions;

		// TODO(bug): This will create a new buffer each time the document is written.
		// Surely that's avoidable?
		const fallbackBuffer = this.doc.createBuffer();
		const fallbackBufferIndex = this.doc.getRoot().listBuffers().indexOf(fallbackBuffer);

		this._encoderFallbackBuffer = fallbackBuffer;
		this._encoderBufferViews = {};
		this._encoderBufferViewData = {};
		this._encoderBufferViewAccessors = {};

		for (const accessor of this.doc.getRoot().listAccessors()) {
			const usage = getUsage(accessor, this.doc);
			const mode = getMeshoptMode(accessor, usage);
			const filter = options.method === EncoderMethod.FILTER
				? getMeshoptFilter(accessor, this.doc)
				: MeshoptFilter.NONE;
			const {array, byteStride} = prepareArray(accessor, encoder, mode, filter);

			// TODO(confirm): Can't align to 4-byte boundaries, just skip? https://skfb.ly/6qAD8
			if (getTargetPath(accessor) === 'weights') continue;

			const buffer = accessor.getBuffer();
			if (!buffer) throw new Error(`${NAME}: Missing buffer for accessor.`);
			const bufferIndex = this.doc.getRoot().listBuffers().indexOf(buffer);

			// Buffer view grouping key.
			const key = [usage, mode, filter, byteStride, bufferIndex].join(':');

			let bufferView = this._encoderBufferViews[key];
			let bufferViewData = this._encoderBufferViewData[key];
			let bufferViewAccessors = this._encoderBufferViewAccessors[key];

			// Write new buffer view, if needed.
			if (!bufferView || !bufferViewData) {
				bufferViewAccessors = this._encoderBufferViewAccessors[key] = [];
				bufferViewData = this._encoderBufferViewData[key] = [];
				bufferView = this._encoderBufferViews[key] = {
					buffer: fallbackBufferIndex,
					target: USAGE_TO_TARGET[usage],
					byteOffset: 0,
					byteLength: 0,
					byteStride: usage === BufferViewUsage.ARRAY_BUFFER ? byteStride : undefined,
					extensions: {
						[NAME]: {
							buffer: bufferIndex,
							byteOffset: 0,
							byteLength: 0,
							mode: mode,
							filter: filter,
							byteStride: byteStride,
							count: 0
						}
					}
				};
			}

			// Write accessor.
			const accessorDef = context.createAccessorDef(accessor);
			accessorDef.byteOffset = bufferView.byteLength;
			context.accessorIndexMap.set(accessor, json.accessors!.length);
			json.accessors!.push(accessorDef);
			bufferViewAccessors.push(accessorDef);

			// Update buffer view.
			bufferViewData.push(array.slice().buffer);
			bufferView.byteLength += array.byteLength; // TODO(confirm): Padding?
			bufferView.extensions.EXT_meshopt_compression.count += accessor.getCount();
		}
	}

	private _prewriteBuffers(context: WriterContext): void {
		const encoder = this._encoder!;

		for (const key in this._encoderBufferViews) {
			const bufferView = this._encoderBufferViews[key];
			const bufferViewData = this._encoderBufferViewData[key];
			const buffer = this.doc.getRoot().listBuffers()[bufferView.extensions[NAME].buffer];
			const otherBufferViews = context.otherBufferViews.get(buffer) || [];

			const {count, byteStride, mode} = bufferView.extensions[NAME];
			const srcArray = new Uint8Array(BufferUtils.concat(bufferViewData));
			const dstArray = encoder.encodeGltfBuffer(srcArray, count, byteStride, mode);
			const compressedData = BufferUtils.pad(dstArray.slice().buffer);

			bufferView.byteLength = srcArray.byteLength;
			bufferView.extensions[NAME].byteLength = dstArray.byteLength;

			// TODO(cleanup): Remove debugging.
			// bufferView.extras = {
			// 	key,
			// 	numAccessors: bufferViewData.length,
			// 	// accessors: this._encoderBufferViewAccessors[key],
			// };

			bufferViewData.length = 0;
			bufferViewData.push(compressedData);
			otherBufferViews.push(compressedData);
			context.otherBufferViews.set(buffer, otherBufferViews);
		}
	}

	public write(context: WriterContext): this {
		let fallbackBufferByteOffset = 0;

		// Write final encoded buffer view properties.
		for (const key in this._encoderBufferViews) {
			const bufferView = this._encoderBufferViews[key];
			const bufferViewData = this._encoderBufferViewData[key][0];
			const bufferViewIndex = context.otherBufferViewsIndexMap.get(bufferViewData)!;

			const bufferViewAccessors = this._encoderBufferViewAccessors[key];
			for (const accessorDef of bufferViewAccessors) {
				accessorDef.bufferView = bufferViewIndex;
			}

			const finalBufferViewDef = context.jsonDoc.json.bufferViews![bufferViewIndex];
			const compressedByteOffset = finalBufferViewDef.byteOffset || 0;

			Object.assign(finalBufferViewDef, bufferView);
			finalBufferViewDef.byteOffset = fallbackBufferByteOffset;
			const bufferViewExtensionDef = finalBufferViewDef.extensions![NAME] as
				MeshoptBufferViewExtension;
			bufferViewExtensionDef.byteOffset = compressedByteOffset;

			fallbackBufferByteOffset += BufferUtils.padNumber(bufferView.byteLength);
		}

		// TODO(cleanup)
		// console.log(JSON.stringify(context.jsonDoc.json.bufferViews, null, 2));

		// Write final fallback buffer.
		const fallbackBuffer = this._encoderFallbackBuffer!;
		const fallbackBufferIndex = context.bufferIndexMap.get(fallbackBuffer)!;
		const fallbackBufferDef = context.jsonDoc.json.buffers![fallbackBufferIndex];
		fallbackBufferDef.byteLength = fallbackBufferByteOffset;
		fallbackBufferDef.extensions = {[NAME]: {fallback: true}};
		fallbackBuffer.dispose();
		return this;
	}
}

function prepareArray(
	accessor: Accessor,
	encoder: typeof MeshoptEncoder,
	mode: MeshoptMode,
	filter: MeshoptFilter
): ({array: TypedArray, byteStride: number}) {
	let array = accessor.getArray()!;
	let byteStride = array.byteLength / accessor.getCount();

	if (mode === MeshoptMode.ATTRIBUTES && filter !== MeshoptFilter.NONE) {
		if (filter === MeshoptFilter.EXPONENTIAL) {
			byteStride = accessor.getElementSize() * 4;
			array = encoder.encodeFilterExp(
				new Float32Array(array), accessor.getCount(), byteStride, 12
			);
		} else if (filter === MeshoptFilter.OCTAHEDRAL) {
			// TODO(bug): Add .w component to normals?
			byteStride = 8;
			array = encoder.encodeFilterOct(
				new Float32Array(array), accessor.getCount(), byteStride, 8
			);
		} else if (filter === MeshoptFilter.QUATERNION) {
			byteStride = 8;
			array = encoder.encodeFilterQuat(
				new Float32Array(array), accessor.getCount(), byteStride, 16
			);
		}
	} else if (mode === MeshoptMode.ATTRIBUTES && byteStride % 4) {
		array = padArrayElements(array, accessor.getElementSize());
		byteStride = array.byteLength / accessor.getCount();
	}

	return {array, byteStride};
}

function padArrayElements<T extends TypedArray>(srcArray: T, elementSize: number): T {
	const byteStride = BufferUtils.padNumber(srcArray.BYTES_PER_ELEMENT * elementSize);
	const elementStride = byteStride / srcArray.BYTES_PER_ELEMENT;
	const elementCount = srcArray.length / elementSize;
	const dstArray = new (srcArray as any).constructor(elementCount * elementStride) as T;
	for (let i = 0; i * elementSize < srcArray.length; i++) {
		for (let j = 0; j < elementSize; j++) {
			dstArray[i * elementStride + j] = srcArray[i * elementSize + j];
		}
	}
	return dstArray;
}

/**
 * Returns true for a fallback buffer, else false.
 *
 *   - All references to the fallback buffer must come from bufferViews that
 *     have a EXT_meshopt_compression extension specified.
 *   - No references to the fallback buffer may come from
 *     EXT_meshopt_compression extension JSON.
 *
 * @internal
 */
function isFallbackBuffer(bufferDef: GLTF.IBuffer): boolean {
	if (!bufferDef.extensions || !bufferDef.extensions[NAME]) return false;
	const fallbackDef = bufferDef.extensions[NAME] as MeshoptBufferExtension;
	return !!fallbackDef.fallback;
}

// TODO(cleanup): Don't duplicate this from Writer...
const BufferViewUsage = {
	ARRAY_BUFFER: 'ARRAY_BUFFER',
	ELEMENT_ARRAY_BUFFER: 'ELEMENT_ARRAY_BUFFER',
	INVERSE_BIND_MATRICES: 'INVERSE_BIND_MATRICES',
	OTHER: 'OTHER',
};
const USAGE_TO_TARGET = {
	[BufferViewUsage.ARRAY_BUFFER]: BufferViewTarget.ARRAY_BUFFER,
	[BufferViewUsage.ELEMENT_ARRAY_BUFFER]: BufferViewTarget.ELEMENT_ARRAY_BUFFER,
};
function getUsage(accessor: Accessor, doc: Document): string {
	for (const link of doc.getGraph().listParentLinks(accessor)) {
		if (link.getName() === 'inverseBindMatrices') {
			return BufferViewUsage.INVERSE_BIND_MATRICES;
		}
		if (link instanceof AttributeLink) {
			return BufferViewUsage.ARRAY_BUFFER;
		}
		if (link instanceof IndexLink) {
			return BufferViewUsage.ELEMENT_ARRAY_BUFFER;
		}
	}
	return BufferViewUsage.OTHER;
}

function getMeshoptMode(accessor: Accessor, usage: string): MeshoptMode {
	if (usage === 'ELEMENT_ARRAY_BUFFER') {
		const isTriangles = accessor.listParents()
			.some((parent) => {
				return parent instanceof Primitive && parent.getMode() === Primitive.Mode.TRIANGLES;
			});
		return isTriangles ? MeshoptMode.TRIANGLES : MeshoptMode.INDICES;
	}

	return MeshoptMode.ATTRIBUTES;
}

function getMeshoptFilter(accessor: Accessor, doc: Document): MeshoptFilter {
	const semantics = doc.getGraph().listParentLinks(accessor)
		.map((link) => (link as AttributeLink).getName())
		.filter((name) => name !== 'accessor');
	for (const semantic of semantics) {
		// TODO(bug): Need to pad the normals with a .w component, I think?
		if (semantic === 'NORMAL') return MeshoptFilter.NONE;
		if (semantic === 'TANGENT') return MeshoptFilter.OCTAHEDRAL;
		if (semantic.startsWith('JOINTS_')) return MeshoptFilter.NONE;
		if (semantic.startsWith('WEIGHTS_')) return MeshoptFilter.NONE;
		if (semantic === 'output') {
			const targetPath = getTargetPath(accessor);
			if (targetPath === 'rotation') return MeshoptFilter.NONE;
			if (targetPath === 'translation') return MeshoptFilter.EXPONENTIAL;
			if (targetPath === 'scale') return MeshoptFilter.EXPONENTIAL;
			return MeshoptFilter.NONE;
		}
		// TODO(feat): Exponential? Index sequence?
		if (semantic === 'input') return MeshoptFilter.NONE;
		if (semantic === 'inverseBindMatrices') return MeshoptFilter.NONE;
	}

	// console.log({semantics, filter: 'EXPONENTIAL'});
	return MeshoptFilter.EXPONENTIAL;
}

function getTargetPath(accessor: Accessor): GLTF.AnimationChannelTargetPath | null {
	for (const sampler of accessor.listParents()) {
		if (!(sampler instanceof AnimationSampler)) continue;
		for (const channel of sampler.listParents()) {
			if (!(channel instanceof AnimationChannel)) continue;
			return channel.getTargetPath();
		}
	}
	return null;
}
