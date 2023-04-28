import ArrayBufferSlice from '../../ArrayBufferSlice';
import { AssetFile, UnityMaterialData } from './AssetManager';
import { UnityRuntime, MeshRenderer as UnityMeshRenderer, UnityMaterialFactory, UnityMaterialInstance, createUnityRuntime, UnityShaderProgramBase } from './GameObject';
import { makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from '../../gfx/helpers/RenderGraphHelpers';
import { fillMatrix4x4, fillVec4 } from '../../gfx/helpers/UniformBufferHelpers';
import { GfxDevice, GfxInputState, GfxBindingLayoutDescriptor, GfxProgram } from '../../gfx/platform/GfxPlatform';
import { GfxrAttachmentSlot } from '../../gfx/render/GfxRenderGraph';
import { GfxRenderHelper } from '../../gfx/render/GfxRenderHelper';
import { GfxRenderInst } from '../../gfx/render/GfxRenderInstManager';
import { SceneContext } from '../../SceneBase';
import { TextureMapping } from '../../TextureHolder';
import { fallback, nArray } from '../../util';
import * as Viewer from '../../viewer';

class TempMaterialProgram extends UnityShaderProgramBase {
    public static ub_MaterialParams = 2;

    public override both = `
${UnityShaderProgramBase.Common}

layout(std140) uniform ub_MaterialParams {
    vec4 u_Color;
    vec4 u_MainTexST;
    vec4 u_Misc[1];
};

#define u_AlphaCutoff (u_Misc[0].x)

varying vec2 v_LightIntensity;
varying vec2 v_TexCoord0;
varying vec4 v_Color;

#ifdef VERT
void mainVS() {
    Mat4x3 t_WorldFromLocalMatrix = CalcWorldFromLocalMatrix();
    vec3 t_PositionWorld = Mul(t_WorldFromLocalMatrix, vec4(a_Position, 1.0));
    vec3 t_LightDirection = normalize(vec3(.2, -1, .5));
    vec3 normal = MulNormalMatrix(t_WorldFromLocalMatrix, normalize(a_Normal));
    float t_LightIntensityF = dot(-normal, t_LightDirection);
    float t_LightIntensityB = dot( normal, t_LightDirection);

    gl_Position = Mul(u_ProjectionView, vec4(t_PositionWorld, 1.0));
    v_LightIntensity = vec2(t_LightIntensityF, t_LightIntensityB);
    v_TexCoord0 = CalcScaleBias(a_TexCoord0, u_MainTexST);
    v_Color = a_Color;
}
#endif

#ifdef FRAG
uniform sampler2D u_Texture;

vec4 noBlack(vec4 color) {
    if (color.r == 0.0 && color.g == 0.0 && color.b == 0.0) {
        return vec4(1.0, 1.0, 1.0, 1.0);
    }
    else {
        return color;
    }
}

void mainPS() {
    vec4 t_Color = u_Color * noBlack(v_Color) * (textureSize(u_Texture, 0).x > 1 ? texture(u_Texture, v_TexCoord0) : vec4(1.0));

    if (t_Color.a < u_AlphaCutoff)
        discard;

    float t_LightIntensity = gl_FrontFacing ? v_LightIntensity.x : v_LightIntensity.y;
    float t_LightTint = 0.2 * t_LightIntensity;
    vec4 t_FinalColor = t_Color + vec4(t_LightTint, t_LightTint, t_LightTint, 0.0);
    t_FinalColor.rgb = pow(t_FinalColor.rgb, vec3(1.0 / 2.2));
    gl_FragColor = t_FinalColor;
}
#endif
`;
}

class TempMaterial extends UnityMaterialInstance {
    public textureMapping = nArray(1, () => new TextureMapping());
    public program = new TempMaterialProgram();
    public gfxProgram: GfxProgram;
    public alphaCutoff: number = 0.0;

    constructor(runtime: UnityRuntime, private materialData: UnityMaterialData) {
        super();

        this.materialData.fillTextureMapping(this.textureMapping[0], '_MainTex');
        this.alphaCutoff = fallback(this.materialData.getFloat('_Cutoff'), 0.0);

        if (this.materialData.name.includes('Terrain'))
            this.alphaCutoff = 0.0;

        this.gfxProgram = runtime.assetSystem.renderCache.createProgram(this.program);
    }

    public prepareToRender(renderInst: GfxRenderInst): void {
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);

        let offs = renderInst.allocateUniformBuffer(TempMaterialProgram.ub_MaterialParams, 12);
        const d = renderInst.mapUniformBufferF32(TempMaterialProgram.ub_MaterialParams);

        offs += this.materialData.fillColor(d, offs, '_Color');
        offs += this.materialData.fillTexEnvScaleBias(d, offs, '_MainTex');
        offs += fillVec4(d, offs, this.alphaCutoff);

        renderInst.setGfxProgram(this.gfxProgram);
    }
}

class TempMaterialFactory extends UnityMaterialFactory {
    public createMaterialInstance(runtime: UnityRuntime, materialData: UnityMaterialData): UnityMaterialInstance {
        // TODO(jstpierre): Pull out serialized shader data
        return new TempMaterial(runtime, materialData);
    }
}

const bindingLayouts = [
    { numUniformBuffers: 3, numSamplers: 6, },
];

class UnityRenderer implements Viewer.SceneGfx {
    private renderHelper: GfxRenderHelper;
    public inputState: GfxInputState;

    constructor(private runtime: UnityRuntime) {
        this.renderHelper = new GfxRenderHelper(this.runtime.context.device, this.runtime.context);
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        viewerInput.camera.setClipPlanes(0.05, 1000);
        this.runtime.update();

        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        let offs = template.allocateUniformBuffer(0, 32);
        const mapped = template.mapUniformBufferF32(0);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.clipFromWorldMatrix);

        const meshRenderers = this.runtime.getComponents(UnityMeshRenderer);
        for (let i = 0; i < meshRenderers.length; i++)
            meshRenderers[i].prepareToRender(this.renderHelper.renderInstManager, viewerInput);

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
    }

    public destroy(device: GfxDevice) {
        this.runtime.destroy(device);
        this.renderHelper.destroy();
    }
}

export async function createFileDropsScene(context: SceneContext, buffer: ArrayBufferSlice): Promise<Viewer.SceneGfx> {
    const runtime = await createUnityRuntime(context, `AShortHike`);
    runtime.materialFactory = new TempMaterialFactory();
    await runtime.loadBuffer(buffer);

    const renderer = new UnityRenderer(runtime);
    return renderer;
}

