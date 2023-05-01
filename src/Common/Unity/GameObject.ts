
import type { UnityObject } from "../../../rust/pkg/index";
import { GfxCullMode, GfxDevice } from "../../gfx/platform/GfxPlatform";
import { SceneContext } from "../../SceneBase";
import { AssetObjectData, UnityAssetSystem, RustModule, AssetLocation, UnityMeshData, UnityChannel, UnityMaterialData, UnityAssetResourceType, AssetFile } from "./AssetManager";
import type * as wasm from '../../../rust/pkg/index';
import { mat4, quat, vec3, vec4 } from "gl-matrix";
import { assert, assertExists, fallbackUndefined, nArray, readString } from "../../util";
import { GfxRenderInst, GfxRenderInstManager } from "../../gfx/render/GfxRenderInstManager";
import { ViewerRenderInput } from "../../viewer";
import { DeviceProgram } from "../../Program";
import { fillColor, fillMatrix4x3, fillVec4, fillVec4v } from "../../gfx/helpers/UniformBufferHelpers";
import { GfxShaderLibrary } from "../../gfx/helpers/GfxShaderLibrary";
import { TextureMapping } from "../../TextureHolder";
import ArrayBufferSlice from '../../ArrayBufferSlice';

interface WasmBindgenArray<T> {
    length: number;
    get(i: number): T;
    free(): void;
}

function loadWasmBindgenArray<T>(wasmArr: WasmBindgenArray<T>): T[] {
    const jsArr: T[] = Array<T>(wasmArr.length);
    for (let i = 0; i < wasmArr.length; i++)
        jsArr[i] = wasmArr.get(i);
    wasmArr.free();
    return jsArr;
}

export abstract class UnityComponent {
    public async load(runtime: UnityRuntime): Promise<void> {
    }

    public spawn(runtime: UnityRuntime): void {
    }

    public destroy(device: GfxDevice): void {
    }
}

function vec3FromVec3f(dst: vec3, src: wasm.Vec3f): void {
    vec3.set(dst, src.x, src.y, src.z);
}

function quatFromQuaternion(dst: quat, src: wasm.Quaternion): void {
    quat.set(dst, src.x, src.y, src.z, src.w);
}

export class Transform extends UnityComponent {
    public localPosition = vec3.create();
    public localRotation = quat.create();
    public localScale = vec3.create();
    public parent: Transform | null = null;
    public children: Transform[] = [];

    public modelMatrix = mat4.create();

    constructor(runtime: UnityRuntime, public gameObject: GameObject, private wasmObj: wasm.Transform) {
        super();
        vec3FromVec3f(this.localPosition, wasmObj.local_position);
        quatFromQuaternion(this.localRotation, wasmObj.local_rotation);
        vec3FromVec3f(this.localScale, wasmObj.local_scale);
    }

    public override spawn(runtime: UnityRuntime): void {
        if (this.wasmObj) {
            super.spawn(runtime);
            this.parent = runtime.findComponentByPPtr(this.wasmObj.parent);
            this.children = loadWasmBindgenArray(this.wasmObj.get_children()).map((pptr) => {
                return assertExists(runtime.findComponentByPPtr<Transform>(pptr));
            });
            this.wasmObj.free();
            this.wasmObj = null!;
        }
    }

    public updateModelMatrix(): void {
        mat4.fromRotationTranslationScale(this.modelMatrix, this.localRotation, this.localPosition, this.localScale);

        if (this.parent !== null)
            mat4.mul(this.modelMatrix, this.parent.modelMatrix, this.modelMatrix);

        for (let i = 0; i < this.children.length; i++)
            this.children[i].updateModelMatrix();
    }
}

export class MeshFilter extends UnityComponent {
    public meshData: UnityMeshData | null = null;

    constructor(runtime: UnityRuntime, public gameObject: GameObject, wasmObj: wasm.MeshFilter) {
        super();
        this.loadMeshData(runtime, wasmObj);
    }

    private async loadMeshData(runtime: UnityRuntime, wasmObj: wasm.MeshFilter) {
        this.meshData = await runtime.assetSystem.fetchResource(UnityAssetResourceType.Mesh, this.gameObject.location, wasmObj.mesh_ptr);
        wasmObj.free();
    }

    public override destroy(device: GfxDevice): void {
        if (this.meshData !== null)
            this.meshData.destroy(device);
    }
}

export class UnityShaderProgramBase extends DeviceProgram {
    public static ub_SceneParams = 0;
    public static ub_ShapeParams = 1;

    public static Common = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ProjectionView;
};

layout(std140) uniform ub_ShapeParams {
    // TODO(jstpierre): Skinned mesh
    Mat4x3 u_BoneMatrix[1];
};

#ifdef VERT
layout(location = ${UnityChannel.Vertex}) attribute vec3 a_Position;
layout(location = ${UnityChannel.Normal}) attribute vec3 a_Normal;
layout(location = ${UnityChannel.Tangent}) attribute vec3 a_Tangent;
layout(location = ${UnityChannel.Color}) attribute vec4 a_Color;
layout(location = ${UnityChannel.TexCoord0}) attribute vec2 a_TexCoord0;
layout(location = ${UnityChannel.TexCoord1}) attribute vec2 a_TexCoord1;
layout(location = ${UnityChannel.TexCoord2}) attribute vec2 a_TexCoord2;
layout(location = ${UnityChannel.TexCoord3}) attribute vec2 a_TexCoord3;
layout(location = ${UnityChannel.TexCoord4}) attribute vec2 a_TexCoord4;
layout(location = ${UnityChannel.TexCoord5}) attribute vec2 a_TexCoord5;
layout(location = ${UnityChannel.TexCoord6}) attribute vec2 a_TexCoord6;
layout(location = ${UnityChannel.TexCoord7}) attribute vec2 a_TexCoord7;
layout(location = ${UnityChannel.BlendWeight}) attribute vec4 a_BlendWeight;
layout(location = ${UnityChannel.BlendIndices}) attribute vec4 a_BlendIndices;

${GfxShaderLibrary.MulNormalMatrix}
${GfxShaderLibrary.CalcScaleBias}

Mat4x3 CalcWorldFromLocalMatrix() {
    return u_BoneMatrix[0];
}
#endif
`;
}

export abstract class UnityMaterialInstance {
    public abstract prepareToRender(renderInst: GfxRenderInst): void;
}

export class MeshRenderer extends UnityComponent {
    private staticBatchSubmeshStart = 0;
    private staticBatchSubmeshCount = 0;
    private visible = true;
    private modelMatrix = mat4.create();
    private materials: (UnityMaterialInstance | null)[];

    constructor(runtime: UnityRuntime, public gameObject: GameObject, private header: wasm.MeshRenderer) {
        super();
        this.visible = header.enabled;
        this.staticBatchSubmeshStart = header.static_batch_info.first_submesh;
        this.staticBatchSubmeshCount = header.static_batch_info.submesh_count;
    }

    public override async load(runtime: UnityRuntime) {
        const materials = this.header.get_materials();
        this.materials = nArray(materials.length, () => null);
        for (let i = 0; i < materials.length; i++) {
            const materialPPtr = materials.get(i)!;
            // Don't wait on materials, we can render them as they load in...
            this.fetchMaterial(runtime, i, materialPPtr);
            materialPPtr.free();
        }
        materials.free();
    }

    private async fetchMaterial(runtime: UnityRuntime, i: number, pptr: wasm.PPtr) {
        const materialData = await runtime.assetSystem.fetchResource(UnityAssetResourceType.Material, this.gameObject.location, pptr);
        if (materialData === null)
            return;

        this.materials[i] = runtime.materialFactory.createMaterialInstance(runtime, materialData);
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput): void {
        if (!this.visible || !this.gameObject.visible)
            return;

        const meshFilter = this.gameObject.getComponent(MeshFilter);
        if (meshFilter === null)
            return;

        const meshData = meshFilter.meshData;
        if (meshData === null)
            return;

        // TODO(jstpierre): AABB culling

        if (this.staticBatchSubmeshCount > 0) {
            mat4.identity(this.modelMatrix);
        } else {
            // TODO(jstpierre): Skinned meshes
            const transform = assertExists(this.gameObject.getComponent(Transform));
            mat4.copy(this.modelMatrix, transform.modelMatrix);
        }

        const template = renderInstManager.pushTemplateRenderInst();

        let offs = template.allocateUniformBuffer(UnityShaderProgramBase.ub_ShapeParams, 12);
        const mapped = template.mapUniformBufferF32(UnityShaderProgramBase.ub_ShapeParams);

        offs += fillMatrix4x3(mapped, offs, this.modelMatrix);

        template.setInputLayoutAndState(meshData.inputLayout, meshData.inputState);

        let submeshIndex = 0;
        const submeshCount = this.staticBatchSubmeshCount !== 0 ? this.staticBatchSubmeshCount : meshData.submeshes.length;
        for (let i = 0; i < this.materials.length; i++) {
            const submesh = meshData.submeshes[this.staticBatchSubmeshStart + submeshIndex];
            if (submeshIndex < submeshCount - 1)
                submeshIndex++;

            const material = this.materials[i];
            if (material === null)
                continue;

            const renderInst = renderInstManager.newRenderInst();
            material.prepareToRender(renderInst);
            const firstIndex = submesh.first_byte / meshData.indexBufferStride;
            renderInst.drawIndexes(submesh.index_count, firstIndex);
            renderInst.setMegaStateFlags({ cullMode: GfxCullMode.Back });
            renderInstManager.submitRenderInst(renderInst);
        }

        renderInstManager.popTemplateRenderInst();
    }

    public override destroy(device: GfxDevice): void {
        this.header.free();
    }
}

export class GameObject {
    public name: string;
    public layer = 0;
    public isActive = true;
    public visible = true;
    public components: UnityComponent[] = [];

    constructor(public location: AssetLocation, private header: wasm.GameObject) {
        this.name = this.header.name;
    }

    public async load(runtime: UnityRuntime) {
        const components = loadWasmBindgenArray(this.header.get_components());
        await Promise.all(components.map(async (pptr) => {
            const data = await runtime.assetSystem.fetchPPtr(this.location, pptr);
            pptr.free();
            const loadPromise = runtime.loadComponent(this, data);
            if (loadPromise !== null)
                await loadPromise;
        }));
    }

    public getComponent<T extends UnityComponent>(constructor: ComponentConstructor<T, any>): T | null {
        for (let i = 0; i < this.components.length; i++)
            if (this.components[i] instanceof constructor)
                return this.components[i] as T;
        return null;
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.components.length; i++)
            this.components[i].destroy(device);
        this.header.free();
    }
}

let _wasm: RustModule | null = null;
async function loadWasm(): Promise<RustModule> {
    if (_wasm === null) {
        _wasm = await import('../../../rust/pkg/index');
    }
    return _wasm;
}

interface WasmFromBytes<T> {
    from_bytes(data: Uint8Array, assetInfo: wasm.AssetInfo): any;
}

interface ComponentConstructor<CompT, WasmT> {
    new(runtime: UnityRuntime, gameObject: GameObject, wasm: WasmT): CompT;
}

export abstract class UnityMaterialFactory {
    public abstract createMaterialInstance(runtime: UnityRuntime, materialData: UnityMaterialData): UnityMaterialInstance;
}

export class UnityRuntime {
    public gameObjects: GameObject[] = [];
    public components = new Map<number, UnityComponent>();
    public rootGameObjects: GameObject[] = [];
    public assetSystem: UnityAssetSystem;
    public materialFactory: UnityMaterialFactory;

    constructor(private wasm: RustModule, public context: SceneContext, basePath: string) {
        this.assetSystem = new UnityAssetSystem(this.wasm, context.device, context.dataFetcher, basePath);
    }

    public findGameObjectByPPtr(pptr: wasm.PPtr): GameObject | null {
        assert(pptr.file_index === 0);
        if (pptr.path_id === 0)
            return null;
        return fallbackUndefined(this.gameObjects.find((obj) => obj.location.pathID === pptr.path_id), null);
    }

    public findComponentByPPtr<T extends UnityComponent>(pptr: wasm.PPtr): T | null {
        assert(pptr.file_index === 0);
        if (pptr.path_id === 0)
            return null;
        return assertExists(this.components.get(pptr.path_id)) as unknown as T;
    }

    private loadOneComponent<CompT extends UnityComponent, WasmT>(obj: AssetObjectData, gameObject: GameObject, fromBytes: WasmFromBytes<WasmT>, constructor: ComponentConstructor<CompT, WasmT>): Promise<void> {
        const wasmObj = fromBytes.from_bytes(obj.data, obj.assetInfo);
        const comp = new constructor(this, gameObject, wasmObj);
        gameObject.components.push(comp);
        this.components.set(obj.location.pathID, comp);
        return comp.load(this);
    }

    public loadComponent(gameObject: GameObject, obj: AssetObjectData): Promise<void> | null {
        if (obj.classID === this.wasm.UnityClassID.Transform) {
            return this.loadOneComponent(obj, gameObject, this.wasm.Transform, Transform);
        } else if (obj.classID === this.wasm.UnityClassID.RectTransform) {
            // HACK(jstpierre)
            return this.loadOneComponent(obj, gameObject, this.wasm.Transform, Transform);
        } else if (obj.classID === this.wasm.UnityClassID.MeshFilter) {
            return this.loadOneComponent(obj, gameObject, this.wasm.MeshFilter, MeshFilter);
        } else if (obj.classID === this.wasm.UnityClassID.MeshRenderer) {
            return this.loadOneComponent(obj, gameObject, this.wasm.MeshRenderer, MeshRenderer);
        } else {
            return null;
        }
    }

    public async loadLevel(filename: string) {
        const assetFile = this.assetSystem.fetchAssetFile(filename, false);
        await assetFile.waitForHeader();
        return this.loadAsset(assetFile);
    }
    
    public async loadBuffer(buffer: ArrayBufferSlice): Promise<void> {
        if (readString(buffer, 0, 8) == "UnityFS") {
            const assetFiles = this.assetSystem.fetchBundleBuffer(buffer);
            const promises = Array<Promise<void>>(assetFiles.length);
            for (let i = 0; i < assetFiles.length; i++) {
                promises[i] = this.loadAsset(assetFiles[i]);
            }
            await Promise.all(promises);
        }
        else {
            const assetFile = this.assetSystem.fetchAssetBuffer("<buffer>", buffer);
            await this.loadAsset(assetFile);
        }
    }
    
    private async loadAsset(assetFile: AssetFile): Promise<void> {
        // Instantiate all the GameObjects.
        const loadGameObject = async (unityObject: UnityObject) => {
            const pathID = unityObject.path_id;
            const objData = await assetFile.fetchObject(pathID);
            const wasmGameObject = this.wasm.GameObject.from_bytes(objData.data, assetFile.assetInfo);
            const gameObject = new GameObject(objData.location, wasmGameObject);
            gameObject.isActive = wasmGameObject.is_active;
            gameObject.layer = wasmGameObject.layer;
            this.gameObjects.push(gameObject);
            await gameObject.load(this);
        };

        const promises = [];
        for (let i = 0; i < assetFile.unityObject.length; i++) {
            const unityObject = assetFile.unityObject[i];
            if (unityObject.class_id !== this.wasm.UnityClassID.GameObject)
                continue;

            promises.push(loadGameObject(unityObject));
        }

        await this.assetSystem.waitForLoad();
        await Promise.all(promises);

        // Spawn all the components.
        for (const component of this.components.values())
            component.spawn(this);

        await this.assetSystem.waitForLoad();

        this.rootGameObjects = this.gameObjects.filter((obj) => {
            const transform = obj.getComponent(Transform);
            return transform && transform.parent === null;
        });

        for (let i = 0; i < this.rootGameObjects.length; i++)
            assertExists(this.rootGameObjects[i].getComponent(Transform)).updateModelMatrix();
    }

    public getComponents<T extends UnityComponent>(constructor: ComponentConstructor<T, any>): T[] {
        return this.gameObjects.map((gameObject) => {
            return gameObject.components.filter((comp) => comp instanceof constructor) as T[];
        }).flat();
    }

    public update(): void {
        this.assetSystem.update();
    }

    public destroy(device: GfxDevice): void {
        this.components.clear();
        for (let i = 0; i < this.gameObjects.length; i++)
            this.gameObjects[i].destroy(device);
        this.assetSystem.destroy(device);
    }
}

export async function createUnityRuntime(context: SceneContext, basePath: string): Promise<UnityRuntime> {
    const wasm = await loadWasm();
    const runtime = await context.dataShare.ensureObject(`UnityRuntime/${basePath}`, async () => {
        return new UnityRuntime(wasm, context, basePath);
    });
    return runtime;
}
