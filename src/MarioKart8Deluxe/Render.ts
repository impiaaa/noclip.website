
import * as Viewer from '../viewer.js';
import { TextureHolder, LoadedTexture, TextureMapping } from '../TextureHolder.js';

import { GfxDevice, GfxSampler, GfxWrapMode, GfxMipFilterMode, GfxTexFilterMode, GfxCullMode, GfxCompareMode, GfxInputLayout, GfxBuffer, GfxBufferUsage, GfxFormat, GfxVertexAttributeDescriptor, GfxVertexBufferFrequency, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxBlendMode, GfxBlendFactor, GfxProgram, GfxMegaStateDescriptor, GfxIndexBufferDescriptor, GfxInputLayoutBufferDescriptor, makeTextureDescriptor2D, GfxChannelWriteMask } from '../gfx/platform/GfxPlatform.js';

import * as BNTX from '../fres_nx/bntx.js';
import { surfaceToCanvas } from '../Common/bc_texture.js';
import { translateImageFormat, deswizzle, decompress, getImageFormatString } from '../fres_nx/tegra_texture.js';
import { FMDL, FSHP, FMAT, FMAT_RenderInfo, FMAT_RenderInfoType, FVTX, FSHP_Mesh, FRES, FVTX_VertexAttribute, FVTX_VertexBuffer, parseFMAT_ShaderParam_Float4, FMAT_ShaderParam, parseFMAT_ShaderParam_Color3, parseFMAT_ShaderParam_Float, parseFMAT_ShaderParam_Texsrt, parseFMAT_ShaderParam_Float2, FMAT_ShaderAssign } from '../fres_nx/bfres.js';
import { GfxRenderInst, makeSortKey, GfxRendererLayer, setSortKeyDepth, GfxRenderInstManager, GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { TextureAddressMode, FilterMode, IndexFormat, AttributeFormat, getChannelFormat, getTypeFormat } from '../fres_nx/nngfx_enum.js';
import { nArray, assert, assertExists, fallbackUndefined } from '../util.js';
import { makeStaticDataBuffer, makeStaticDataBufferFromSlice } from '../gfx/helpers/BufferHelpers.js';
import { fillMatrix4x4, fillMatrix4x3, fillVec4v, fillColor, fillVec3v, fillMatrix4x2, fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { mat4, ReadonlyMat4, vec2, vec3, vec4 } from 'gl-matrix';
import { computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';
import { AABB } from '../Geometry.js';
import { reverseDepthForCompareMode } from '../gfx/helpers/ReversedDepthHelpers.js';
import { DeviceProgram } from '../Program.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { GfxShaderLibrary, glslGenerateFloat } from '../gfx/helpers/GfxShaderLibrary.js';
import { getMatrixTranslation, MathConstants, Vec3Zero } from '../MathHelpers.js';

import * as SARC from "../fres_nx/sarc.js";
import * as AGLLightMap from './AGLParameter_LightMap.js';
import * as AGLEnv from './AGLParameter_Env.js';
import { colorNewCopy, colorScale, OpaqueBlack, White } from '../Color.js';
import { IS_DEVELOPMENT } from '../BuildVersion.js';

export class BRTITextureHolder extends TextureHolder<BNTX.BRTI> {
    public addFRESTextures(device: GfxDevice, fres: FRES): void {
        const bntxFile = fres.externalFiles.find((f) => f.name === 'textures.bntx');
        if (bntxFile !== undefined)
            this.addBNTXFile(device, bntxFile.buffer);
    }

    public addBNTXFile(device: GfxDevice, buffer: ArrayBufferSlice): void {
        const bntx = BNTX.parse(buffer);
        this.addTextures(device, bntx.textures);
    }

    public loadTexture(device: GfxDevice, textureEntry: BNTX.BRTI): LoadedTexture | null {
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(translateImageFormat(textureEntry.imageFormat), textureEntry.width, textureEntry.height, textureEntry.mipBuffers.length));
        const canvases: HTMLCanvasElement[] = [];

        const channelFormat = getChannelFormat(textureEntry.imageFormat);

        for (let i = 0; i < textureEntry.mipBuffers.length; i++) {
            const mipLevel = i;

            const buffer = textureEntry.mipBuffers[i];
            const width = Math.max(textureEntry.width >>> mipLevel, 1);
            const height = Math.max(textureEntry.height >>> mipLevel, 1);
            const depth = 1;
            const blockHeightLog2 = textureEntry.blockHeightLog2;
            deswizzle({ buffer, width, height, channelFormat, blockHeightLog2 }).then((deswizzled) => {
                const rgbaTexture = decompress({ ...textureEntry, width, height, depth }, deswizzled);
                const rgbaPixels = rgbaTexture.pixels;
                device.uploadTextureData(gfxTexture, mipLevel, [rgbaPixels]);

                const canvas = document.createElement('canvas');
                surfaceToCanvas(canvas, rgbaTexture);
                canvases.push(canvas);
            });
        }

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', getImageFormatString(textureEntry.imageFormat));

        const viewerTexture: Viewer.Texture = { name: textureEntry.name, surfaces: canvases, extraInfo };
        return { viewerTexture, gfxTexture };
    }
}

function translateAddressMode(addrMode: TextureAddressMode): GfxWrapMode {
    switch (addrMode) {
    case TextureAddressMode.Repeat:
        return GfxWrapMode.Repeat;
    case TextureAddressMode.ClampToEdge:
    case TextureAddressMode.ClampToBorder:
        return GfxWrapMode.Clamp;
    case TextureAddressMode.Mirror:
        return GfxWrapMode.Mirror;
    case TextureAddressMode.MirrorClampToEdge:
        // TODO(jstpierre): This requires GL_ARB_texture_mirror_clamp_to_edge
        return GfxWrapMode.Mirror;
    default:
        throw "whoops";
    }
}

function translateMipFilterMode(filterMode: FilterMode): GfxMipFilterMode {
    switch (filterMode) {
    case FilterMode.Linear:
        return GfxMipFilterMode.Linear;
    case FilterMode.Point:
        return GfxMipFilterMode.Nearest;
    case 0:
        return GfxMipFilterMode.NoMip;
    default:
        throw "whoops";
    }
}

function translateTexFilterMode(filterMode: FilterMode): GfxTexFilterMode {
    switch (filterMode) {
    case FilterMode.Linear:
        return GfxTexFilterMode.Bilinear;
    case FilterMode.Point:
        return GfxTexFilterMode.Point;
    default:
        throw "whoops";
    }
}

class TurboUBER extends DeviceProgram {
    public static a_Orders = [ '_p0', '_c0', '_u0', '_u1', '_u2', '_u3', '_n0', '_t0' ];
    public static s_Orders = ['_a0', '_s0', '_n0', '_n1', '_e0', '_b0', '_b1', '_a1', '_a2', '_a3', '_t0' ];

    public static ub_SceneParams = 0;
    public static ub_MaterialParams = 1;

    public static NumEnvLightParams = 2;

    constructor(public fmat: FMAT) {
        super();

        this.name = this.fmat.name;
        assert(this.fmat.samplerInfo.length <= 8);

        this.frag = this.generateFrag();
    }

    public static globalDefinitions = `
precision mediump float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_ShapeParams {
    Mat4x4 u_ProjectionView;
    vec4 u_CameraPosWorld;
};

struct EnvLightParam {
    vec4 BacksideColor;
    vec4 DiffuseColor;
    vec4 Direction;
};

layout(std140) uniform ub_MaterialParams {
    Mat3x4 u_Model;
    Mat2x4 u_TexCoordSRT0;
    vec4 u_TexCoordBake0ScaleBias;
    vec4 u_TexCoordBake1ScaleBias;
    Mat2x4 u_TexCoordSRT2;
    Mat2x4 u_TexCoordSRT3;
    vec4 u_AlbedoColorAndTransparency;
    vec4 u_EmissionColorAndNormalMapWeight;
    vec4 u_SpecularColorAndIntensity;
    vec4 u_BakeLightScaleAndRoughness;
    vec4 u_TransmissionColorAndIntensity;

    vec4 u_MultiTexReg[3];
    vec4 u_Misc[1];
    EnvLightParam u_EnvLightParams[${TurboUBER.NumEnvLightParams}];

};

#define u_AlbedoColor (u_AlbedoColorAndTransparency.rgb)
#define u_Transparency (u_AlbedoColorAndTransparency.a)
#define u_EmissionColor (u_EmissionColorAndNormalMapWeight.rgb)
#define u_NormalMapWeight (u_EmissionColorAndNormalMapWeight.a)
#define u_SpecularColor (u_SpecularColorAndIntensity.rgb)
#define u_SpecularIntensity (u_SpecularColorAndIntensity.a)
#define u_BakeLightScale (u_BakeLightScaleAndRoughness.rgb)
#define u_SpecularRoughness (u_BakeLightScaleAndRoughness.a)
#define u_IndirectMag (u_Misc[0].xy)

${GfxShaderLibrary.CalcScaleBias}

uniform sampler2D u_TextureAlbedo0;   // _a0
uniform sampler2D u_TextureSpecMask;  // _s0
uniform sampler2D u_TextureNormal0;   // _n0
uniform sampler2D u_TextureNormal1;   // _n1
uniform sampler2D u_TextureEmission0; // _e0
uniform sampler2D u_TextureBake0;     // _b0
uniform sampler2D u_TextureBake1;     // _b1
uniform sampler2D u_TextureMultiA;    // _a1
uniform sampler2D u_TextureMultiB;    // _a2
uniform sampler2D u_TextureIndirect;  // _a3
uniform sampler2D u_TextureTransmission;  // _t0

`;

    public override both = TurboUBER.globalDefinitions;

    public override vert = `
layout(location = ${this.getAttrLocation('_p0')}) in vec3 a_p0; // _p0
layout(location = ${this.getAttrLocation('_c0')}) in vec4 a_c0; // _c0
layout(location = ${this.getAttrLocation('_u0')}) in vec2 a_u0; // _u0
layout(location = ${this.getAttrLocation('_u1')}) in vec2 a_u1; // _u1
layout(location = ${this.getAttrLocation('_u2')}) in vec2 a_u2; // _u2
layout(location = ${this.getAttrLocation('_u3')}) in vec2 a_u3; // _u3
layout(location = ${this.getAttrLocation('_n0')}) in vec4 a_n0; // _n0
layout(location = ${this.getAttrLocation('_t0')}) in vec4 a_t0; // _t0

#define a_Position  (a${this.getAttrAssign('_p0')})
#define a_Color     (a${this.getAttrAssign('_c0')})
#define a_TexCoord0 (a${this.getAttrAssign('_u0')})
#define a_TexCoord1 (a${this.getAttrAssign('_u1')})
#define a_TexCoord2 (a${this.getAttrAssign('_u2')})
#define a_TexCoord3 (a${this.getAttrAssign('_u3')})
#define a_Normal    (a${this.getAttrAssign('_n0')})
#define a_Tangent   (a${this.getAttrAssign('_t0')})

out vec3 v_PositionWorld;
out vec2 v_TexCoord0;
out vec4 v_TexCoordBake;
out vec4 v_TexCoord23;
out vec4 v_VtxColor;
out vec3 v_NormalWorld;
out vec4 v_TangentWorld;

void main() {
    v_PositionWorld = UnpackMatrix(u_Model) * vec4(a_Position, 1.0);
    gl_Position = UnpackMatrix(u_ProjectionView) * vec4(v_PositionWorld, 1.0);

    bool gsys_invalidate_texture_srt = ${this.shaderOptionBool('gsys_invalidate_texture_srt')};

    if (gsys_invalidate_texture_srt) {
        v_TexCoord0 = a_TexCoord0.xy;
        v_TexCoord23.xy = a_TexCoord2.xy;
        v_TexCoord23.zw = a_TexCoord3.xy;
    } else {
        v_TexCoord0 = UnpackMatrix(u_TexCoordSRT0) * vec4(a_TexCoord0.xy, 1.0, 1.0);
        v_TexCoord23.xy = UnpackMatrix(u_TexCoordSRT2) * vec4(a_TexCoord2.xy, 1.0, 1.0);
        v_TexCoord23.zw = UnpackMatrix(u_TexCoordSRT3) * vec4(a_TexCoord3.xy, 1.0, 1.0);
    }

    v_TexCoordBake.xy = CalcScaleBias(a_TexCoord1.xy, u_TexCoordBake0ScaleBias);
    v_TexCoordBake.zw = CalcScaleBias(a_TexCoord1.xy, u_TexCoordBake1ScaleBias);

    v_VtxColor = a_Color;
    v_NormalWorld.xyz = normalize(a_Normal.xyz);
    v_TangentWorld.xyzw = a_Tangent.xyzw;
}
`;

    private getAttrAssign(attrName: string): string {
        const attrAssign = this.fmat.shaderAssign.attrAssign;
        return fallbackUndefined(attrAssign.get(attrName), attrName);
    }

    private getAttrLocation(attrName: string): number {
        const index = TurboUBER.a_Orders.indexOf(attrName);
        assert(index >= 0);
        return index;
    }

    private isTranslucent(): boolean {
        const render_state_mode = getRenderInfoSingleString(this.fmat.renderInfo.get('gsys_render_state_mode')!);
        return render_state_mode === 'translucent';
    }

    private shaderOptionBool(name: string, fallback: boolean = false): boolean {
        let v = this.fmat.shaderAssign.shaderOption.get(name);
        if (v !== undefined) {
            assert(v === '0' || v === '1');
            return v === '1';
        } else {
            return fallback;
        }
    }

    private shaderOptionInt(name: string, fallback: number = -1): string {
        let v = this.fmat.shaderAssign.shaderOption.get(name);
        if (v !== undefined) {
            return v;
        } else {
            return '' + fallback;
        }
    }

    public generateFrag() {
        return `
precision mediump float;

${GfxShaderLibrary.saturate}

in vec3 v_PositionWorld;
in vec2 v_TexCoord0;
in vec4 v_TexCoordBake;
in vec4 v_TexCoord23;
in vec4 v_VtxColor;
in vec3 v_NormalWorld;
in vec4 v_TangentWorld;

struct BakeResult {
    vec3 IndirectLight;
    float Shadow;
    float AO;
};

struct LightResult {
    vec3 DiffuseColor;
    vec3 SpecularColor;
};

struct DirectionalLight {
    vec3 Color;
    vec3 BacksideColor;
    vec3 Direction;
    bool Wrapped;
    bool VisibleInShadow;
};

struct SurfaceLightParams {
    vec3 SurfaceNormal;
    vec3 SurfacePointToEyeDir;
    vec3 SpecularColor;
    float IntensityFromShadow;
    float SpecularRoughness;
};

float G1V(float NoV, float k) {
    return 1.0 / (NoV * (1.0 - k) + k);
}

void CalcDirectionalLight(inout LightResult t_Result, in SurfaceLightParams t_SurfaceLightParams, in DirectionalLight t_Light) {
    vec3 N = t_SurfaceLightParams.SurfaceNormal.xyz;
    // Surface point to light
    vec3 L = normalize(-t_Light.Direction.xyz);
    // Surface point to eye
    vec3 V = t_SurfaceLightParams.SurfacePointToEyeDir.xyz;

    float NoL = dot(N, L);

    float t_Intensity = t_SurfaceLightParams.IntensityFromShadow;
    if (t_Light.VisibleInShadow)
        t_Intensity = 1.0;
    vec3 t_LightColor = t_Light.Color * t_Intensity;
    vec3 t_BacksideColor = t_Light.BacksideColor * t_Intensity;

    // Diffuse
    {
        float t_LightVisibility = NoL;

        // Wrapped lighting
        if (t_Light.Wrapped)
            t_LightVisibility = t_LightVisibility * 0.5 + 0.5;
        else
            t_LightVisibility = saturate(t_LightVisibility);

        t_Result.DiffuseColor += mix(t_BacksideColor, t_LightColor, t_LightVisibility);
    }

    // Specular

    // TODO(jstpierre): Replace with cubemaps
    if (!t_Light.VisibleInShadow) {
        // Stolen from: http://filmicworlds.com/blog/optimizing-ggx-update/

        vec3 H = normalize(L + V);
        float NoV = saturate(dot(N, V));
        float NoH = saturate(dot(N, H));
        float LoH = saturate(dot(L, H));

        float r = t_SurfaceLightParams.SpecularRoughness;
        float a = r * r;
        float a2 = a * a;

        // D
        float D = a2 / (3.14159 * pow(NoH * NoH * (a2 - 1.0) + 1.0, 2.0));

        // F
        // Stolen from: https://seblagarde.wordpress.com/2012/06/03/spherical-gaussien-approximation-for-blinn-phong-phong-and-fresnel/
        // float LoH5 = exp2((-5.55473 * LoH - 6.98316) * LoH);
        vec3 F0 = vec3(0.05);
        float LoH5 = pow(1.0 - LoH, 5.0);
        vec3 F = F0 + (1.0 - F0) * LoH5;

        // vis / G
        float k = a / 2.0;
        float vis = G1V(NoL, k) * G1V(NoV, k);

        vec3 t_SpecularResponse = D * F * vis;
        t_Result.SpecularColor += saturate(NoL) * t_SpecularResponse.rgb * t_LightColor.rgb * t_SurfaceLightParams.SpecularColor.rgb;
    }
}

void CalcEnvLight(out LightResult t_Result, in SurfaceLightParams t_SurfaceLightParams) {
    t_Result.DiffuseColor = vec3(0.0);
    t_Result.SpecularColor = vec3(0.0);

    for (int i = 0; i < 2; i++) {
        EnvLightParam t_EnvLightParam = u_EnvLightParams[i];

        DirectionalLight t_Light;
        t_Light.Color = t_EnvLightParam.DiffuseColor.rgb;
        t_Light.BacksideColor = t_EnvLightParam.BacksideColor.rgb;
        t_Light.Direction = t_EnvLightParam.Direction.xyz;
        t_Light.Wrapped = bool(t_EnvLightParam.BacksideColor.a != 0.0);
        t_Light.VisibleInShadow = bool(t_EnvLightParam.DiffuseColor.a != 0.0);

        CalcDirectionalLight(t_Result, t_SurfaceLightParams, t_Light);
    }
}

void CalcBakeResult(out BakeResult t_Result, in vec4 t_TexCoordBake) {
    bool enable_bake_texture = ${this.shaderOptionBool('enable_bake_texture')};

    int bake_light_type = enable_bake_texture ? ${this.shaderOptionInt('bake_light_type')} : -1;
    if (bake_light_type == 0) {
        // Lightmap.
        vec4 t_Bake1Sample = texture(SAMPLER_2D(u_TextureBake1), t_TexCoordBake.zw);
        vec3 t_Bake1Color = t_Bake1Sample.rgb * t_Bake1Sample.a;
        t_Result.IndirectLight = t_Bake1Color * u_BakeLightScale.rgb;
    } else {
        // Unknown.
        t_Result.IndirectLight = vec3(0.0);
    }

    int bake_shadow_type = enable_bake_texture ? ${this.shaderOptionInt('bake_shadow_type')} : -1;
    if (bake_shadow_type == 0) {
        float t_BakeSample = texture(SAMPLER_2D(u_TextureBake0), t_TexCoordBake.xy).r;
        t_Result.AO = t_BakeSample;
        t_Result.Shadow = 1.0;
    } else if (bake_shadow_type == 1) {
        float t_BakeSample = texture(SAMPLER_2D(u_TextureBake0), t_TexCoordBake.xy).r;
        t_Result.AO = 1.0;
        t_Result.Shadow = t_BakeSample;
    } else if (bake_shadow_type == 2) {
        vec2 t_BakeSample = texture(SAMPLER_2D(u_TextureBake0), t_TexCoordBake.xy).rg;
        t_Result.AO = t_BakeSample.r;
        t_Result.Shadow = t_BakeSample.g;
    } else {
        // Unknown.
        t_Result.AO = 1.0;
        t_Result.Shadow = 1.0;
    }
}

vec2 SelectTexCoord(in int t_Selection) {
    if (t_Selection == 0)
        return v_TexCoord0.xy;
    else if (t_Selection == 2)
        return v_TexCoord23.xy;
    else if (t_Selection == 3)
        return v_TexCoord23.zw;
    else
        return vec2(0.0); // error!
}

void Indirect(inout vec2 t_TexCoord, bool t_Condition) {
    if (!t_Condition)
        return;

    vec2 t_IndTexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_indirectA')});
    vec2 t_IndOffset = texture(SAMPLER_2D(u_TextureIndirect), t_IndTexCoord).rg;
    bool indirect_texture_is_BC5s = ${this.shaderOptionBool('indirect_texture_is_BC5s')};
    if (!indirect_texture_is_BC5s) {
        t_IndOffset = t_IndOffset * 2.0 - 1.0;
    }
    t_IndOffset *= u_IndirectMag.xy;
    t_TexCoord += t_IndOffset;
}

vec4 SampleMultiTexA() {
    vec2 t_TexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_multiA')});
    Indirect(t_TexCoord.xy, ${this.shaderOptionBool('indirect_effect_multiA')});
    return texture(SAMPLER_2D(u_TextureMultiA), t_TexCoord.xy);
}

vec4 SampleMultiTexB() {
    vec2 t_TexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_multiB')});
    Indirect(t_TexCoord.xy, ${this.shaderOptionBool('indirect_effect_multiB')});
    return texture(SAMPLER_2D(u_TextureMultiB), t_TexCoord.xy);
}

float CalcGeoMultiAlpha(PD_SAMPLER_2D(t_Texture)) {
    int geo_multi_alpha_type = ${this.shaderOptionInt('geo_multi_alpha_type')};
    if (geo_multi_alpha_type == 1) {
        return texture(PU_SAMPLER_2D(t_Texture), SelectTexCoord(0)).a;
    } else if (geo_multi_alpha_type == 2) {
        return texture(PU_SAMPLER_2D(t_Texture), SelectTexCoord(2)).a;
    } else if (geo_multi_alpha_type == 3) {
        return texture(PU_SAMPLER_2D(t_Texture), SelectTexCoord(3)).a;
    } else {
        return v_VtxColor.a * u_Transparency;
    }
}

void CalcGeoMultiTextureSpec(inout vec3 t_SpecMask) {
    bool enable_geo_multi = ${this.shaderOptionBool('enable_geo_multi')};
    if (!enable_geo_multi)
        return;

    int geo_multi_specmask_calc_type = ${this.shaderOptionInt('geo_multi_specmask_calc_type')};
    if (geo_multi_specmask_calc_type == 0) {
        int multi_tex_calc_type_color = ${this.shaderOptionInt('multi_tex_calc_type_color')};
        if (multi_tex_calc_type_color == 0)
            t_SpecMask.rgb = mix(t_SpecMask.rgb, SampleMultiTexB().rgb, CalcGeoMultiAlpha(PP_SAMPLER_2D(u_TextureAlbedo0)));
        if (multi_tex_calc_type_color == 7)
            t_SpecMask.rgb = mix(t_SpecMask.rgb, SampleMultiTexB().rgb, CalcGeoMultiAlpha(PP_SAMPLER_2D(u_TextureMultiA)));
    } else if (geo_multi_specmask_calc_type == 1) {
        t_SpecMask.rgb *= SampleMultiTexB().rgb;
    }
}

void CalcMultiTexture(in int t_OutputType, inout vec4 t_Sample) {
    bool enable_multi_texture = ${this.shaderOptionBool('enable_multi_texture')};
    if (!enable_multi_texture)
        return;

    int multi_tex_output_type = ${this.shaderOptionInt('multi_tex_output_type')};
    if (t_OutputType != multi_tex_output_type)
        return;

    bool enable_geo_multi = ${this.shaderOptionBool('enable_geo_multi')};
    if (enable_geo_multi) {
        int geo_multi_alpha_type = ${this.shaderOptionInt('geo_multi_alpha_type')};
        if (geo_multi_alpha_type == 1) {
            t_Sample.rgb = mix(t_Sample.rgb, SampleMultiTexA().rgb, CalcGeoMultiAlpha(PP_SAMPLER_2D(u_TextureMultiA)));
        } else if (geo_multi_alpha_type == 2) {
            t_Sample.rgb = mix(t_Sample.rgb, SampleMultiTexA().rgb, CalcGeoMultiAlpha(PP_SAMPLER_2D(u_TextureAlbedo0)));
        }

        return;
    }

    int multi_tex_calc_type_color = ${this.shaderOptionInt('multi_tex_calc_type_color')};
    if (multi_tex_calc_type_color == 0) {
        // This space intentionally left blank.
    } else if (multi_tex_calc_type_color == 1) {
        t_Sample.rgb *= SampleMultiTexA().rgb;
    } else if (multi_tex_calc_type_color == 2) {
        t_Sample.rgb *= SampleMultiTexA().rgb * SampleMultiTexB().rgb;
    } else if (multi_tex_calc_type_color == 3) {
        t_Sample.rgb = mix(t_Sample.rgb - SampleMultiTexA().rgb, SampleMultiTexA().rgb, t_Sample.a);
    } else if (multi_tex_calc_type_color == 5) {
        t_Sample.rgb = saturate((t_Sample.rgb + SampleMultiTexA().rgb - u_MultiTexReg[0].r) * u_MultiTexReg[0].g);
    } else if (multi_tex_calc_type_color == 6) {
        t_Sample.rgb = saturate((t_Sample.rgb + SampleMultiTexB().rgb - u_MultiTexReg[0].r) * u_MultiTexReg[0].g);
    } else if (multi_tex_calc_type_color == 7) {
        t_Sample.rgb = mix(t_Sample.rgb, SampleMultiTexA().rgb, SampleMultiTexA().a);
    } else if (multi_tex_calc_type_color == 8) {
        vec3 t_Sum = saturate(t_Sample.rgb + SampleMultiTexA().rgb + SampleMultiTexB().rgb - u_MultiTexReg[0].r) * u_MultiTexReg[0].g;
        t_Sample.rgb = mix(u_MultiTexReg[2].rgb, u_MultiTexReg[1].rgb, t_Sum);
    } else if (multi_tex_calc_type_color == 11) {
        t_Sample.rgb = mix(u_MultiTexReg[0].rgb, u_MultiTexReg[1].rgb, t_Sample.a);
    } else if (multi_tex_calc_type_color == 12) {
        t_Sample.rgb = saturate(t_Sample.rgb * SampleMultiTexA().rgb + SampleMultiTexB().rgb);
    } else if (multi_tex_calc_type_color == 13) {
        t_Sample.rgb = saturate(SampleMultiTexA().rgb + SampleMultiTexB().rgb - u_MultiTexReg[0].r) * u_MultiTexReg[0].g;
    } else if (multi_tex_calc_type_color == 14) {
        t_Sample.rgb = mix(u_MultiTexReg[0].rgb, t_Sample.rgb, t_Sample.a);
    } else if (multi_tex_calc_type_color == 17) {
        t_Sample.rgb = mix(SampleMultiTexA().rgb * u_MultiTexReg[0].rgb, t_Sample.rgb, u_MultiTexReg[0].a);
    } else if (multi_tex_calc_type_color == 19) {
        t_Sample.rgb = t_Sample.rgb * saturate(SampleMultiTexA().rgb + u_MultiTexReg[0].rgb);
    } else if (multi_tex_calc_type_color == 20) {
        t_Sample.rgb = mix(u_MultiTexReg[0].rgb, t_Sample.rgb, v_VtxColor.rgb);
    } else if (multi_tex_calc_type_color == 21) {
        t_Sample.rgb = mix(u_MultiTexReg[0].rgb, u_MultiTexReg[1].rgb, (t_Sample.r + t_Sample.g + t_Sample.b) / 3.0);
    } else if (multi_tex_calc_type_color == 22) {
        t_Sample.rgb = saturate(t_Sample.rgb + SampleMultiTexA().rgb * SampleMultiTexB().rgb);
    } else if (multi_tex_calc_type_color == 24) {
        t_Sample.rgb += mix(u_MultiTexReg[0].rgb, u_MultiTexReg[1].rgb, SampleMultiTexA().r) * SampleMultiTexA().r * u_MultiTexReg[0].a * u_MultiTexReg[1].a;
    } else if (multi_tex_calc_type_color == 25) {
        t_Sample.rgb += mix(u_MultiTexReg[0].rgb + u_MultiTexReg[1].rgb,  u_MultiTexReg[2].rgb, SampleMultiTexA().r) * SampleMultiTexA().x * u_MultiTexReg[0].a * u_MultiTexReg[1].a;
    } else if (multi_tex_calc_type_color == 27) {
        t_Sample.rgb = saturate(SampleMultiTexA().rgb * u_MultiTexReg[0].rgb + t_Sample.rgb);
    } else if (multi_tex_calc_type_color == 30) {
        t_Sample.rgb *= SampleMultiTexA().rgb + SampleMultiTexB().rgb;
    } else if (multi_tex_calc_type_color == 33) {
        t_Sample.rgb = SampleMultiTexA().rgb * u_MultiTexReg[0].rgb + t_Sample.rgb;
    } else if (multi_tex_calc_type_color == 34) {
        t_Sample.rgb = SampleMultiTexA().rgb + t_Sample.rgb;
    } else if (multi_tex_calc_type_color == 35) {
        t_Sample.rgb = SampleMultiTexA().rgb + t_Sample.rgb; // same as 34?
    } else if (multi_tex_calc_type_color == 38) {
        t_Sample.rgb += (SampleMultiTexA().rgb * (vec3(1.0) - SampleMultiTexB().rgb)) * u_MultiTexReg[0].r;
    } else if (multi_tex_calc_type_color == 39) {
        t_Sample.rgb *= u_MultiTexReg[0].rgb + u_MultiTexReg[1].rgb * SampleMultiTexA().rgb;
    } else if (multi_tex_calc_type_color == 40) {
        t_Sample.rgb = SampleMultiTexA().rgb * SampleMultiTexA().a * v_VtxColor.r + t_Sample.rgb;
    } else if (multi_tex_calc_type_color == 44) {
        t_Sample.rgb = saturate((t_Sample.rgb - SampleMultiTexA().rgb - u_MultiTexReg[0].rrr) * u_MultiTexReg[0].ggg);
    } else {
        // Unknown multi texture calc type.
        bool is_development = ${IS_DEVELOPMENT};
        if (is_development)
            t_Sample.rgb = vec3(1.0, 0.0, 1.0);
    }

    int multi_tex_calc_type_alpha = ${this.shaderOptionInt('multi_tex_calc_type_alpha')};
    if (multi_tex_calc_type_alpha == 0) {
        // This space intentionally left blank.
    } else if (multi_tex_calc_type_alpha == 1) {
        t_Sample.a *= SampleMultiTexA().a;
    } else if (multi_tex_calc_type_alpha == 4) {
        t_Sample.a = (SampleMultiTexA().a + SampleMultiTexA().b - u_MultiTexReg[0].b) * u_MultiTexReg[0].a;
    } else if (multi_tex_calc_type_alpha == 6) {
        t_Sample.a = SampleMultiTexA().a;
    } else if (multi_tex_calc_type_alpha == 7) {
        t_Sample.a = SampleMultiTexA().r;
    } else if (multi_tex_calc_type_alpha == 8) {
        t_Sample.a = SampleMultiTexB().r;
    } else {
        // Unknown multi texture calc type.
        bool is_development = ${IS_DEVELOPMENT};
        if (is_development)
            t_Sample.rgb = vec3(1.0, 1.0, 0.0);
    }
}

vec3 ReconstructNormal(in vec2 t_NormalXY) {
    float t_NormalZ = sqrt(saturate(1.0 - dot(t_NormalXY.xy, t_NormalXY.xy)));
    return vec3(t_NormalXY.xy, t_NormalZ);
}

vec3 UnpackNormalMap(in vec4 t_NormalMapSample) {
    bool normalmap_bc1 = ${this.shaderOptionBool('gsys_normalmap_BC1')};

    vec2 t_NormalXY = t_NormalMapSample.xy;
    if (normalmap_bc1) {
        t_NormalXY = t_NormalXY * 2.0 - 1.0;
    }

    return ReconstructNormal(t_NormalXY);
}

vec3 SampleNormalMap0() {
    vec2 t_TexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_normal')});
    Indirect(t_TexCoord.xy, ${this.shaderOptionBool('indirect_effect_normal')});
    vec4 t_NormalMapSample = texture(SAMPLER_2D(u_TextureNormal0), t_TexCoord);
    return UnpackNormalMap(t_NormalMapSample);
}

vec3 SampleNormalMap1() {
    vec2 t_TexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_normal2')});
    vec4 t_NormalMapSample = texture(SAMPLER_2D(u_TextureNormal0), t_TexCoord);
    return UnpackNormalMap(t_NormalMapSample);
}

vec3 CalcTangentToWorld(in vec3 t_TangentNormal, in vec3 t_Basis0, in vec3 t_Basis1, in vec3 t_Basis2) {
    return t_TangentNormal.xxx * t_Basis0 + t_TangentNormal.yyy * t_Basis1 + t_TangentNormal.zzz * t_Basis2;
}

vec3 CalcNormalWorld() {
    bool enable_normal_map = ${this.shaderOptionBool('enable_normal_map')};
    if (!enable_normal_map)
        return v_NormalWorld.xyz;

    vec3 t_Basis2 = v_NormalWorld.xyz;
    vec3 t_Basis0 = v_TangentWorld.xyz;
    vec3 t_Basis1 = cross(v_NormalWorld.xyz, v_TangentWorld.xyz) * v_TangentWorld.w;

    // We now have our basis. Now sample the normal maps.
    vec3 t_TangentNormal0 = SampleNormalMap0();
    vec3 t_NormalWorld0 = CalcTangentToWorld(t_TangentNormal0, t_Basis0, t_Basis1, t_Basis2);

    bool gsys_enable_normal_map2 = ${this.shaderOptionBool('gsys_enable_normal_map2')};
    if (gsys_enable_normal_map2) {
        vec3 t_TangentNormal1 = SampleNormalMap1();
        vec3 t_NormalWorld1 = CalcTangentToWorld(t_TangentNormal1, t_Basis0, t_Basis1, t_Basis2);
        return normalize(mix(t_NormalWorld0, t_NormalWorld1, u_NormalMapWeight));
    } else {
        return t_NormalWorld0;
    }
}

void main() {
    // ShaderOption settings.
    bool enable_diffuse = ${this.shaderOptionBool('enable_diffuse')};
    bool enable_diffuse2 = ${this.shaderOptionBool('enable_diffuse2')};
    bool enable_albedo = ${this.shaderOptionBool('enable_albedo')};
    bool enable_emission = ${this.shaderOptionBool('enable_emission')};
    bool enable_emission_map = ${this.shaderOptionBool('enable_emission_map')};
    bool enable_specular = ${this.shaderOptionBool('enable_specular')};
    bool enable_specular_mask = ${this.shaderOptionBool('enable_specular_mask')};
    bool enable_specular_mask_rougness = ${this.shaderOptionBool('enable_specular_mask_rougness')};
    bool enable_specular_physical = ${this.shaderOptionBool('enable_specular_physical')};
    bool enable_vtx_color_diff = ${this.shaderOptionBool('enable_vtx_color_diff')};
    bool enable_vtx_color_emission = ${this.shaderOptionBool('enable_vtx_color_emission')};
    bool enable_vtx_color_spec = ${this.shaderOptionBool('enable_vtx_color_spec')};
    bool enable_vtx_alpha_trans = ${this.shaderOptionBool('enable_vtx_alpha_trans')};
    bool enable_decal_ao = ${this.shaderOptionBool('enable_decal_ao')};
    bool enable_opa_trans = ${this.shaderOptionBool('enable_opa_trans')};

    vec4 t_PixelOut = vec4(0.0);
    float t_Alpha = 1.0;

    // Calculate incoming light.
    vec3 t_IncomingLightDiffuse = vec3(0.0);

    BakeResult t_BakeResult;
    CalcBakeResult(t_BakeResult, v_TexCoordBake);
    t_IncomingLightDiffuse += t_BakeResult.IndirectLight;

    vec3 t_NormalWorld = CalcNormalWorld();
    vec3 t_IncomingLightSpecular = vec3(0.0);

    // Flip normals if we're backfacing (shouldn't happen except for transmission)
    if (enable_opa_trans && !gl_FrontFacing)
        t_NormalWorld = -t_NormalWorld;

    vec4 t_AlbedoTex = vec4(1.0);
    vec3 t_Albedo = u_AlbedoColor.rgb;
    vec3 t_Emission = u_EmissionColor.rgb;

    if (enable_diffuse2 && enable_albedo) {
        vec2 t_AlbedoTexCoord = v_TexCoord0.xy;
        Indirect(t_AlbedoTexCoord.xy, ${this.shaderOptionBool('indirect_effect_albedo')});
        vec4 t_AlbedoSample = texture(SAMPLER_2D(u_TextureAlbedo0), t_AlbedoTexCoord.xy);
        t_AlbedoTex.rgba = t_AlbedoSample.rgba;
        CalcMultiTexture(0, t_AlbedoSample);
        t_Albedo.rgb *= t_AlbedoSample.rgb;
        t_Alpha *= t_AlbedoSample.a;
    }

    if (enable_vtx_color_diff) {
        t_Albedo.rgb *= v_VtxColor.rgb;
    }

    vec3 t_SpecMask = vec3(1.0);
    float t_SpecularRoughness = u_SpecularRoughness;
    if (enable_specular) {
        if (enable_specular_mask) {
            vec2 t_SpecularTexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_specmask')});
            Indirect(t_SpecularTexCoord.xy, ${this.shaderOptionBool('indirect_effect_specmask')});
            vec4 t_SpecMaskSample = texture(SAMPLER_2D(u_TextureSpecMask), t_SpecularTexCoord.xy);
            CalcMultiTexture(3, t_SpecMaskSample);
            t_SpecMask.rgb = t_SpecMaskSample.rgb;
            CalcGeoMultiTextureSpec(t_SpecMask);

            if (enable_specular_mask_rougness) {
                t_SpecularRoughness *= 1.0 - t_SpecMask.g;
            }
        }

        if (enable_specular_physical) {
            t_SpecularRoughness = 1.0 - u_SpecularIntensity;
        }
    }

    if (enable_emission && enable_emission_map) {
        vec2 t_EmissionTexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_emission')});
        Indirect(t_EmissionTexCoord.xy, ${this.shaderOptionBool('indirect_effect_emission')});
        vec4 t_EmissionSample = texture(SAMPLER_2D(u_TextureEmission0), t_EmissionTexCoord.xy);
        CalcMultiTexture(1, t_EmissionSample);
        t_Emission.rgb *= t_EmissionSample.rgb;
    }
    if (enable_emission && enable_vtx_color_emission) {
        t_Emission.rgb *= v_VtxColor.rgb;
    }

    vec3 t_SurfacePointToEye = u_CameraPosWorld.xyz - v_PositionWorld.xyz;
    vec3 t_SurfacePointToEyeDir = normalize(t_SurfacePointToEye.xyz);

    SurfaceLightParams t_SurfaceLightParams;
    t_SurfaceLightParams.SurfaceNormal = t_NormalWorld.xyz;
    t_SurfaceLightParams.SurfacePointToEyeDir = t_SurfacePointToEyeDir.xyz;
    t_SurfaceLightParams.SpecularRoughness = t_SpecularRoughness;
    t_SurfaceLightParams.SpecularColor = u_SpecularColor * u_SpecularIntensity * 10.0;
    if (enable_specular) {
        if (enable_specular_mask_rougness) {
            t_SurfaceLightParams.SpecularColor.rgb *= t_SpecMask.rrr;
        } else {
            t_SurfaceLightParams.SpecularColor.rgb *= t_SpecMask.rgb;
        }
        if (enable_vtx_color_spec) {
            t_SurfaceLightParams.SpecularColor.rgb *= v_VtxColor.rgb;
        }
    }

    t_SurfaceLightParams.IntensityFromShadow = t_BakeResult.Shadow;

    if (enable_diffuse) {
        LightResult t_LightResult;
        CalcEnvLight(t_LightResult, t_SurfaceLightParams);

        t_IncomingLightDiffuse += t_LightResult.DiffuseColor;

        // TODO(jstpierre): Calculate specular light from cubemap instead of directional lights.
        t_IncomingLightSpecular += max(t_LightResult.SpecularColor, vec3(0.0));
    } else {
        LightResult t_LightResult;
        t_SurfaceLightParams.SurfaceNormal = vec3(0.0, 1.0, 0.0);
        t_SurfaceLightParams.IntensityFromShadow = 0.0;

        CalcEnvLight(t_LightResult, t_SurfaceLightParams);
        t_IncomingLightDiffuse = mix(t_LightResult.DiffuseColor, vec3(1.0), vec3(t_BakeResult.Shadow));
    }

    if (enable_diffuse2) {
        t_PixelOut.rgb += t_Albedo.rgb * t_IncomingLightDiffuse.rgb;
    }

    vec3 t_AOColor = vec3(t_BakeResult.AO);
    t_PixelOut.rgb *= t_AOColor;

    if (enable_opa_trans) {
        bool enable_opa_trans_tex = ${this.shaderOptionBool('enable_opa_trans_tex')};
        bool enable_opa_trans_albedo = ${this.shaderOptionBool('enable_opa_trans_albedo')};

        vec3 t_Transmission = u_TransmissionColorAndIntensity.rgb * u_TransmissionColorAndIntensity.a;
        if (enable_opa_trans_tex) {
            vec2 t_TransTexCoord = SelectTexCoord(${this.shaderOptionInt('texcoord_select_transmitt')});
            t_Transmission *= texture(SAMPLER_2D(u_TextureTransmission), t_TransTexCoord).rgb;
        }

        if (enable_opa_trans_albedo)
            t_Transmission *= t_Albedo.rgb;

        LightResult t_LightResult; // Backfacing light
        t_SurfaceLightParams.SurfaceNormal = -t_NormalWorld.xyz;

        CalcEnvLight(t_LightResult, t_SurfaceLightParams);

        vec3 t_IncomingLightTransmission =  t_Transmission * t_LightResult.DiffuseColor;
        t_PixelOut.rgb += t_IncomingLightTransmission.rgb;
    }

    if (enable_emission) {
        t_PixelOut.rgb += t_Emission.rgb;
    }

    if (enable_specular) {
        t_PixelOut.rgb += t_IncomingLightSpecular.rgb;
    }

    bool is_xlu = ${this.isTranslucent()};
    if (is_xlu) {
        t_Alpha *= u_Transparency;

        if (enable_vtx_alpha_trans) {
            t_Alpha *= v_VtxColor.a;
        }
    }
    
    if (enable_decal_ao) {
        // Fake it for now...
        vec4 t_StaticShadowSample = vec4(1.0);
        float t_TrailValue =  t_StaticShadowSample.w;

        int decal_trail_type = ${this.shaderOptionInt('decal_trail_type')};

        if (decal_trail_type == 2)  {
            t_TrailValue = saturate(t_TrailValue * -2.0 + 1.9);
            t_PixelOut.rgb = mix( t_PixelOut.rgb, vec3(0.0), t_TrailValue);
        } else if (decal_trail_type == 4) {
            t_TrailValue = ((t_TrailValue - 0.5) * (1.0 + t_BakeResult.Shadow)) * 4.0 + 1.0;
            t_PixelOut.rgb  *= clamp(t_TrailValue, 0.2, 1.8);
        }
    }

    t_PixelOut.a = t_Alpha;

${this.generateAlphaTest()}

    // Gamma correct
    t_PixelOut.rgb = pow(t_PixelOut.rgb, vec3(1.0 / 2.2));

    gl_FragColor = t_PixelOut;
}
`;
    }

    private generateAlphaTestCompare(compare: GfxCompareMode, ref: string) {
        switch (compare) {
        case GfxCompareMode.Never:        return `false`;
        case GfxCompareMode.Less:         return `t_PixelOut.a <  ${ref}`;
        case GfxCompareMode.Equal:        return `t_PixelOut.a == ${ref}`;
        case GfxCompareMode.LessEqual:    return `t_PixelOut.a <= ${ref}`;
        case GfxCompareMode.Greater:      return `t_PixelOut.a >  ${ref}`;
        case GfxCompareMode.NotEqual:     return `t_PixelOut.a != ${ref}`;
        case GfxCompareMode.GreaterEqual: return `t_PixelOut.a >= ${ref}`;
        case GfxCompareMode.Always:       return `true`;
        default: throw "whoops";
        }
    }

    private generateAlphaTest(): string {
        if (!getRenderInfoBoolean(this.fmat.renderInfo.get('gsys_alpha_test_enable')!))
            return '';

        const mode = getRenderInfoCompareMode(this.fmat.renderInfo.get('gsys_alpha_test_func')!);
        const ref = getRenderInfoSingleFloat(this.fmat.renderInfo.get('gsys_alpha_test_value')!);
        const compareExpr = this.generateAlphaTestCompare(mode, glslGenerateFloat(ref));

        return `
    if (!(${compareExpr}))
        discard;
`;
    }
}

function getRenderInfoSingleString(renderInfo: FMAT_RenderInfo): string {
    assert(renderInfo.type === FMAT_RenderInfoType.String && renderInfo.values.length === 1);
    return renderInfo.values[0] as string;
}

function getRenderInfoSingleFloat(renderInfo: FMAT_RenderInfo): number {
    assert(renderInfo.type === FMAT_RenderInfoType.Float && renderInfo.values.length === 1);
    return renderInfo.values[0] as number;
}

function getRenderInfoBoolean(renderInfo: FMAT_RenderInfo): boolean {
    const value = getRenderInfoSingleString(renderInfo);
    if (value === 'true' || value === '1')
        return true;
    else if (value === 'false' || value === '0')
        return false;
    else
        throw "whoops";
}

function translateCullMode(fmat: FMAT): GfxCullMode {
    const display_face = getRenderInfoSingleString(fmat.renderInfo.get('gsys_render_state_display_face')!);
    if (display_face === 'front')
        return GfxCullMode.Back;
    else if (display_face === 'back')
        return GfxCullMode.Front;
    else if (display_face === 'both')
        return GfxCullMode.None;
    else
        throw "whoops";
}

function translateDepthWrite(fmat: FMAT): boolean {
    return getRenderInfoBoolean(fmat.renderInfo.get('gsys_depth_test_write')!);
}

function getRenderInfoCompareMode(renderInfo: FMAT_RenderInfo): GfxCompareMode {
    const value = getRenderInfoSingleString(renderInfo);
    if (value === 'lequal')
        return GfxCompareMode.LessEqual;
    else if (value === 'gequal')
        return GfxCompareMode.GreaterEqual;
    else if (value === 'greater')
        return GfxCompareMode.Greater;
    else
        throw "whoops";
}

function translateDepthCompare(fmat: FMAT): GfxCompareMode {
    if (getRenderInfoBoolean(fmat.renderInfo.get('gsys_depth_test_enable')!)) {
        return getRenderInfoCompareMode(fmat.renderInfo.get('gsys_depth_test_func')!);
    } else {
        return GfxCompareMode.Always;
    }
}

function getRenderInfoBlendMode(renderInfo: FMAT_RenderInfo): GfxBlendMode {
    const value = getRenderInfoSingleString(renderInfo);
    if (value === 'add')
        return GfxBlendMode.Add;
    else
        throw "whoops";
}

function translateRenderInfoBlendFactor(renderInfo: FMAT_RenderInfo): GfxBlendFactor {
    const value = getRenderInfoSingleString(renderInfo);
    if (value === 'src_alpha')
        return GfxBlendFactor.SrcAlpha;
    else if (value === 'one_minus_src_alpha')
        return GfxBlendFactor.OneMinusSrcAlpha;
    else if (value === 'one')
        return GfxBlendFactor.One;
    else if (value === 'zero')
        return GfxBlendFactor.Zero;
    else
        throw "whoops";
}

function findShaderParam(fmat: FMAT, name: string): FMAT_ShaderParam {
    return fmat.shaderParam.find((p) => p.name === name)!;
}

function calcTexMtx_Maya(dst: mat4, scaleS: number, scaleT: number, rotation: number, translationS: number, translationT: number): void {
    const theta = rotation * MathConstants.DEG_TO_RAD;
    const sinR = Math.sin(theta);
    const cosR = Math.cos(theta);

    mat4.identity(dst);

    dst[0]  = scaleS *  cosR;
    dst[4]  = scaleS *  sinR;
    dst[12] = scaleS * ((-0.5 * cosR) - (0.5 * sinR - 0.5) - translationS);

    dst[1]  = scaleT * -sinR;
    dst[5]  = scaleT *  cosR;
    dst[13] = scaleT * ((-0.5 * cosR) + (0.5 * sinR - 0.5) + translationT) + 1.0;
}

function calcTexMtx_Max(dst: mat4, scaleS: number, scaleT: number, rotation: number, translationS: number, translationT: number): void {
    const theta = rotation * MathConstants.DEG_TO_RAD;
    const sinR = Math.sin(theta);
    const cosR = Math.cos(theta);

    mat4.identity(dst);

    dst[0]  = scaleS *  cosR;
    dst[4]  = scaleS *  sinR;
    dst[12] = scaleS * ((-cosR * (translationS + 0.5)) + (sinR * (translationT - 0.5))) + 0.5;

    dst[1]  = scaleT * -sinR;
    dst[5]  = scaleT *  cosR;
    dst[13] = scaleT * (( sinR * (translationS + 0.5)) + (cosR * (translationT - 0.5))) + 0.5;
}

function calcTexMtx_XSI(dst: mat4, scaleS: number, scaleT: number, rotation: number, translationS: number, translationT: number): void {
    const theta = rotation * MathConstants.DEG_TO_RAD;
    const sinR = Math.sin(theta);
    const cosR = Math.cos(theta);

    mat4.identity(dst);

    dst[0]  = scaleS *  cosR;
    dst[4]  = scaleS * -sinR;
    dst[12] = (scaleS *  sinR) - (scaleS * cosR * translationS) - (scaleS * sinR * translationT);

    dst[1]  = scaleT *  sinR;
    dst[5]  = scaleT *  cosR;
    dst[13] = (scaleT * -cosR) - (scaleT * sinR * translationS) + (scaleT * cosR * translationT) + 1.0;
}

const enum TexSRTMode { Maya, Max, XSI }
class TexSRT {
    public mode = TexSRTMode.Maya;
    public scaleS = 1.0;
    public scaleT = 1.0;
    public rotation = 0.0;
    public translationS = 0.0;
    public translationT = 0.0;

    public calc(dst: mat4): void {
        if (this.mode === TexSRTMode.Maya)
            calcTexMtx_Maya(dst, this.scaleS, this.scaleT, this.rotation, this.translationS, this.translationT);
        else if (this.mode === TexSRTMode.Max)
            calcTexMtx_Max(dst, this.scaleS, this.scaleT, this.rotation, this.translationS, this.translationT);
        else if (this.mode === TexSRTMode.XSI)
            calcTexMtx_XSI(dst, this.scaleS, this.scaleT, this.rotation, this.translationS, this.translationT);
    }

    public fillMatrix(d: Float32Array, offs: number): number {
        this.calc(scratchMatrix);
        return fillMatrix4x2(d, offs, scratchMatrix);
    }
}

function createShaderProgram(fmat: FMAT): DeviceProgram {
    const shaderAssign = fmat.shaderAssign;
    if (shaderAssign.shadingModelName === 'turbo_uber' || shaderAssign.shadingModelName === 'turbo_uber_xlu')
        return new TurboUBER(fmat);
    else
        throw "whoops";
}

class FMATInstance {
    public gfxSamplers: GfxSampler[] = [];
    public textureMapping: TextureMapping[] = [];
    private program: DeviceProgram;
    private gfxProgram: GfxProgram;
    private megaStateFlags: Partial<GfxMegaStateDescriptor>;

    public inColorPass: boolean = false;
    public inShadowMap: boolean = false;

    // Shader params, should maybe be generic?
    private texCoordSRT0 = new TexSRT();
    private texCoordBake0ScaleBias = vec4.create();
    private texCoordBake1ScaleBias = vec4.create();
    private texCoordSRT2 = new TexSRT();
    private texCoordSRT3 = new TexSRT();
    private albedoColorAndTransparency = colorNewCopy(White);
    private emissionColorAndNormalMapWeight = colorNewCopy(White);
    private specularColorAndIntensity = colorNewCopy(White);
    private bakeLightScaleAndRoughness = colorNewCopy(White);
    private transmissionColorAndIntensity = colorNewCopy(White);
    private multiTexReg = nArray(3, () => vec4.create());
    private indirectMag = vec2.create();
    private emissionIntensity = 1.0;
    private sortKey: number = 0;

    constructor(cache: GfxRenderCache, textureHolder: BRTITextureHolder, public fmat: FMAT) {
        this.program = createShaderProgram(fmat);

        // Fill in our texture mappings.
        assert(fmat.samplerInfo.length === fmat.textureName.length);

        this.textureMapping = nArray(TurboUBER.s_Orders.length, () => new TextureMapping());
        for (let i = 0; i < fmat.samplerInfo.length; i++) {
            const samplerInfo = fmat.samplerInfo[i];
            const gfxSampler = cache.createSampler({
                wrapS: translateAddressMode(samplerInfo.addrModeU),
                wrapT: translateAddressMode(samplerInfo.addrModeV),
                mipFilter: translateMipFilterMode((samplerInfo.filterMode >>> FilterMode.MipShift) & 0x03),
                minFilter: translateTexFilterMode((samplerInfo.filterMode >>> FilterMode.MinShift) & 0x03),
                magFilter: translateTexFilterMode((samplerInfo.filterMode >>> FilterMode.MagShift) & 0x03),
                maxLOD: samplerInfo.maxLOD,
                minLOD: samplerInfo.minLOD,
            });
            this.gfxSamplers.push(gfxSampler);
        }

        // Go through and assign to shader samplers.

        // As declared by the shader.
        const shaderSamplerNames = TurboUBER.s_Orders;
        for (const [shaderSamplerName, samplerName] of fmat.shaderAssign.samplerAssign.entries()) {
            const samplerIndex = fmat.samplerInfo.findIndex((samplerInfo) => samplerInfo.name === samplerName);
            const shaderSamplerIndex = shaderSamplerNames.indexOf(shaderSamplerName);

            // Unsupported texture type.
            if (shaderSamplerIndex < 0) {
                assert(false);
            }

            assert(samplerIndex >= 0 && shaderSamplerIndex >= 0);

            const shaderMapping = this.textureMapping[shaderSamplerIndex];

            textureHolder.fillTextureMapping(shaderMapping, fmat.textureName[samplerIndex]);
            shaderMapping.gfxSampler = this.gfxSamplers[samplerIndex];
        }

        this.gfxProgram = cache.createProgram(this.program);

        // Render flags.
        this.megaStateFlags = {
            cullMode:       translateCullMode(fmat),
            depthCompare:   reverseDepthForCompareMode(translateDepthCompare(fmat)),
            depthWrite:     translateDepthWrite(fmat),
        };

        const blendMode = getRenderInfoSingleString(fmat.renderInfo.get('gsys_render_state_blend_mode')!);
        if (blendMode === 'color') {
            this.megaStateFlags.attachmentsState = [{
                channelWriteMask: GfxChannelWriteMask.AllChannels,
                rgbBlendState: {
                    blendMode: getRenderInfoBlendMode(fmat.renderInfo.get('gsys_color_blend_rgb_op')!),
                    blendSrcFactor: translateRenderInfoBlendFactor(fmat.renderInfo.get('gsys_color_blend_rgb_src_func')!),
                    blendDstFactor: translateRenderInfoBlendFactor(fmat.renderInfo.get('gsys_color_blend_rgb_dst_func')!),
                },
                alphaBlendState: {
                    blendMode: getRenderInfoBlendMode(fmat.renderInfo.get('gsys_color_blend_alpha_op')!),
                    blendSrcFactor: translateRenderInfoBlendFactor(fmat.renderInfo.get('gsys_color_blend_alpha_src_func')!),
                    blendDstFactor: translateRenderInfoBlendFactor(fmat.renderInfo.get('gsys_color_blend_alpha_dst_func')!),
                },
            }];
        } else if (blendMode === 'none') {
            // Nothing.
        } else {
            throw "whoops";
        }

        const pass = getRenderInfoSingleString(fmat.renderInfo.get('gsys_pass')!);
        if (pass === 'seal')
            this.megaStateFlags.polygonOffset = true;

        // Decide visibility.
        const dynamic_depth_shadow = getRenderInfoBoolean(fmat.renderInfo.get('gsys_dynamic_depth_shadow')!);
        const dynamic_depth_shadow_only = getRenderInfoBoolean(fmat.renderInfo.get('gsys_dynamic_depth_shadow_only')!);

        const static_depth_shadow = getRenderInfoBoolean(fmat.renderInfo.get('gsys_static_depth_shadow')!);
        const static_depth_shadow_only = getRenderInfoBoolean(fmat.renderInfo.get('gsys_static_depth_shadow_only')!);

        this.inColorPass = true;

        if (dynamic_depth_shadow || static_depth_shadow) {
            this.inShadowMap = true;
        }

        if (dynamic_depth_shadow_only || static_depth_shadow_only) {
            this.inShadowMap = true;
            this.inColorPass = false;
        }

        const cube_map_only = getRenderInfoBoolean(fmat.renderInfo.get('gsys_cube_map_only')!);
        if (cube_map_only) {
            this.inColorPass = false;
        }

        // Hacks!
        if (fmat.name.startsWith('CausticsArea')) {
            this.inColorPass = false;
        }

        const programKey = this.gfxProgram.ResourceUniqueId;
        const render_state_mode = getRenderInfoSingleString(fmat.renderInfo.get('gsys_render_state_mode')!);
        if (render_state_mode === 'opaque') {
            this.sortKey = makeSortKey(GfxRendererLayer.OPAQUE, programKey);
        } else if (render_state_mode === 'mask') {
            this.sortKey = makeSortKey(GfxRendererLayer.ALPHA_TEST, programKey);
        } else if (render_state_mode === 'translucent') {
            this.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT, programKey);
        } else {
            throw "whoops";
        }

        parseFMAT_ShaderParam_Texsrt(this.texCoordSRT0, findShaderParam(fmat, 'tex_mtx0'));
        parseFMAT_ShaderParam_Float4(this.texCoordBake0ScaleBias, findShaderParam(fmat, 'gsys_bake_st0'));
        parseFMAT_ShaderParam_Float4(this.texCoordBake1ScaleBias, findShaderParam(fmat, 'gsys_bake_st1'));
        parseFMAT_ShaderParam_Texsrt(this.texCoordSRT2, findShaderParam(fmat, 'tex_mtx1'));
        parseFMAT_ShaderParam_Texsrt(this.texCoordSRT3, findShaderParam(fmat, 'tex_mtx2'));

        parseFMAT_ShaderParam_Color3(this.albedoColorAndTransparency, findShaderParam(fmat, 'albedo_tex_color'));
        parseFMAT_ShaderParam_Color3(this.emissionColorAndNormalMapWeight, findShaderParam(fmat, 'emission_color'));
        parseFMAT_ShaderParam_Color3(this.specularColorAndIntensity, findShaderParam(fmat, 'specular_color'));
        parseFMAT_ShaderParam_Color3(this.bakeLightScaleAndRoughness, findShaderParam(fmat, 'gsys_bake_light_scale'));
        parseFMAT_ShaderParam_Color3(this.transmissionColorAndIntensity, findShaderParam(fmat, 'transmit_color'));

        this.albedoColorAndTransparency.a = parseFMAT_ShaderParam_Float(findShaderParam(fmat, 'transparency'));
        this.emissionColorAndNormalMapWeight.a = parseFMAT_ShaderParam_Float(findShaderParam(fmat, 'normal_map_weight'));
        this.specularColorAndIntensity.a = parseFMAT_ShaderParam_Float(findShaderParam(fmat, 'specular_intensity'));
        this.bakeLightScaleAndRoughness.a = parseFMAT_ShaderParam_Float(findShaderParam(fmat, 'specular_roughness'));
        this.emissionIntensity = parseFMAT_ShaderParam_Float(findShaderParam(fmat, 'emission_intensity'));
        this.transmissionColorAndIntensity.a = parseFMAT_ShaderParam_Float(findShaderParam(fmat, 'transmit_intensity'));

        parseFMAT_ShaderParam_Float4(this.multiTexReg[0], findShaderParam(fmat, 'multi_tex_reg0'));
        parseFMAT_ShaderParam_Float4(this.multiTexReg[1], findShaderParam(fmat, 'multi_tex_reg1'));
        parseFMAT_ShaderParam_Float4(this.multiTexReg[2], findShaderParam(fmat, 'multi_tex_reg2'));
        parseFMAT_ShaderParam_Float2(this.indirectMag, findShaderParam(fmat, 'indirect_mag'));
    }

    public setOnRenderInst(globals: TurboRenderGlobals, renderInst: GfxRenderInst, modelMatrix: ReadonlyMat4): void {
        renderInst.sortKey = this.sortKey;
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setMegaStateFlags(this.megaStateFlags);

        let offs = renderInst.allocateUniformBuffer(TurboUBER.ub_MaterialParams, 4*4 + 4*2*4 + 4*8 + 3*4*TurboUBER.NumEnvLightParams);
        const d = renderInst.mapUniformBufferF32(TurboUBER.ub_MaterialParams);
        offs += fillMatrix4x3(d, offs, modelMatrix);
        offs += this.texCoordSRT0.fillMatrix(d, offs);
        offs += fillVec4v(d, offs, this.texCoordBake0ScaleBias);
        offs += fillVec4v(d, offs, this.texCoordBake1ScaleBias);
        offs += this.texCoordSRT2.fillMatrix(d, offs);
        offs += this.texCoordSRT3.fillMatrix(d, offs);
        offs += fillColor(d, offs, this.albedoColorAndTransparency);
        colorScale(scratchColor, this.emissionColorAndNormalMapWeight, this.emissionIntensity);
        scratchColor.a = this.emissionColorAndNormalMapWeight.a;
        offs += fillColor(d, offs, scratchColor);
        offs += fillColor(d, offs, this.specularColorAndIntensity);
        offs += fillColor(d, offs, this.bakeLightScaleAndRoughness);
        offs += fillColor(d, offs, this.transmissionColorAndIntensity);
        offs += fillVec4v(d, offs, this.multiTexReg[0]);
        offs += fillVec4v(d, offs, this.multiTexReg[1]);
        offs += fillVec4v(d, offs, this.multiTexReg[2]);
        offs += fillVec4(d, offs, this.indirectMag[0], this.indirectMag[1]);

        const lightEnv = globals.lightEnv;
        const lmap = lightEnv.findLightMap(getRenderInfoSingleString(this.fmat.renderInfo.get('gsys_light_diffuse')!));
        offs += lightEnv.fillEnvLightParamsForMap(d, offs, lmap, TurboUBER.NumEnvLightParams);
    }
}

function translateAttributeFormat(attributeFormat: AttributeFormat): GfxFormat {
    switch (attributeFormat) {
    case AttributeFormat._8_8_Unorm:
        return GfxFormat.U8_RG_NORM;
    case AttributeFormat._8_8_Snorm:
        return GfxFormat.S8_RG_NORM;
    case AttributeFormat._8_8_Uint:
        return GfxFormat.U32_RG;
    case AttributeFormat._8_8_8_8_Unorm:
        return GfxFormat.U8_RGBA_NORM;
    case AttributeFormat._8_8_8_8_Snorm:
        return GfxFormat.S8_RGBA_NORM;
    case AttributeFormat._16_16_Unorm:
        return GfxFormat.U16_RG_NORM;
    case AttributeFormat._16_16_Snorm:
        return GfxFormat.S16_RG_NORM;
    case AttributeFormat._16_16_Float:
        return GfxFormat.F16_RG;
    case AttributeFormat._16_16_16_16_Float:
        return GfxFormat.F16_RGBA;
    case AttributeFormat._32_32_Float:
        return GfxFormat.F32_RG;
    case AttributeFormat._32_32_32_Float:
        return GfxFormat.F32_RGB;
    default:
        console.error(getChannelFormat(attributeFormat), getTypeFormat(attributeFormat));
        throw "whoops";
    }
}

interface ConvertedVertexAttribute {
    format: GfxFormat;
    data: ArrayBufferLike;
    stride: number;
}

class FVTXData {
    public vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [];
    public inputBufferDescriptors: (GfxInputLayoutBufferDescriptor | null)[] = [];
    public vertexBufferDescriptors: GfxVertexBufferDescriptor[] = [];

    constructor(device: GfxDevice, public fvtx: FVTX) {
        let nextBufferIndex = fvtx.vertexBuffers.length;

        for (let i = 0; i < fvtx.vertexAttributes.length; i++) {
            const vertexAttribute = fvtx.vertexAttributes[i];
            const bufferIndex = vertexAttribute.bufferIndex;

            if (this.inputBufferDescriptors[bufferIndex] === undefined)
                this.inputBufferDescriptors[bufferIndex] = null;

            const attribLocation = TurboUBER.a_Orders.indexOf(vertexAttribute.name);
            if (attribLocation < 0)
                continue;

            const vertexBuffer = fvtx.vertexBuffers[bufferIndex];
            const convertedAttribute = this.convertVertexAttribute(vertexAttribute, vertexBuffer);
            if (convertedAttribute !== null) {
                const attribBufferIndex = nextBufferIndex++;

                this.vertexAttributeDescriptors.push({
                    location: attribLocation,
                    format: convertedAttribute.format,
                    bufferIndex: attribBufferIndex,
                    // When we convert the buffer we remove the byte offset.
                    bufferByteOffset: 0,
                });

                this.inputBufferDescriptors[attribBufferIndex] = {
                    byteStride: convertedAttribute.stride,
                    frequency: GfxVertexBufferFrequency.PerVertex,
                };

                const gfxBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, convertedAttribute.data);
                this.vertexBufferDescriptors[attribBufferIndex] = {
                    buffer: gfxBuffer,
                    byteOffset: 0,
                };
            } else {
                // Can use buffer data directly.
                this.vertexAttributeDescriptors.push({
                    location: attribLocation,
                    format: translateAttributeFormat(vertexAttribute.format),
                    bufferIndex: bufferIndex,
                    bufferByteOffset: vertexAttribute.offset,
                });

                if (!this.vertexBufferDescriptors[bufferIndex]) {
                    const gfxBuffer = makeStaticDataBufferFromSlice(device, GfxBufferUsage.Vertex, vertexBuffer.data);

                    this.inputBufferDescriptors[bufferIndex] = {
                        byteStride: vertexBuffer.stride,
                        frequency: GfxVertexBufferFrequency.PerVertex,
                    };

                    this.vertexBufferDescriptors[bufferIndex] = {
                        buffer: gfxBuffer,
                        byteOffset: 0,
                    };
                }
            }
        }
    }

    public convertVertexAttribute(vertexAttribute: FVTX_VertexAttribute, vertexBuffer: FVTX_VertexBuffer): ConvertedVertexAttribute | null {
        switch (vertexAttribute.format) {
        case AttributeFormat._10_10_10_2_Snorm:
            return this.convertVertexAttribute_10_10_10_2_Snorm(vertexAttribute, vertexBuffer);
        default:
            return null;
        }
    }

    public convertVertexAttribute_10_10_10_2_Snorm(vertexAttribute: FVTX_VertexAttribute, vertexBuffer: FVTX_VertexBuffer): ConvertedVertexAttribute {
        function signExtend10(n: number): number {
            return (n << 22) >> 22;
        }

        const numElements = vertexBuffer.data.byteLength / vertexBuffer.stride;
        const format = GfxFormat.S16_RGBA_NORM;
        const out = new Int16Array(numElements * 4);
        const stride = out.BYTES_PER_ELEMENT * 4;
        let dst = 0;
        let offs = vertexAttribute.offset;
        const view = vertexBuffer.data.createDataView();
        for (let i = 0; i < numElements; i++) {
            const n = view.getUint32(offs, true);
            out[dst++] = signExtend10((n >>>  0) & 0x3FF) << 4;
            out[dst++] = signExtend10((n >>> 10) & 0x3FF) << 4;
            out[dst++] = signExtend10((n >>> 20) & 0x3FF) << 4;
            out[dst++] = ((n >>> 30) & 0x03) << 14;
            offs += vertexBuffer.stride;
        }

        return { format, data: out.buffer, stride };
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.vertexBufferDescriptors.length; i++)
            if (this.vertexBufferDescriptors[i])
                device.destroyBuffer(this.vertexBufferDescriptors[i].buffer);
    }
}

function translateIndexFormat(indexFormat: IndexFormat): GfxFormat {
    switch (indexFormat) {
    case IndexFormat.Uint8:  return GfxFormat.U8_R;
    case IndexFormat.Uint16: return GfxFormat.U16_R;
    case IndexFormat.Uint32: return GfxFormat.U32_R;
    default: throw "whoops";
    }
}

export class FSHPMeshData {
    public vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    public indexBufferDescriptor: GfxIndexBufferDescriptor;
    public inputLayout: GfxInputLayout;
    public indexBuffer: GfxBuffer;

    constructor(cache: GfxRenderCache, public mesh: FSHP_Mesh, fvtxData: FVTXData) {
        const indexBufferFormat = translateIndexFormat(mesh.indexFormat);
        this.inputLayout = cache.createInputLayout({
            indexBufferFormat,
            vertexAttributeDescriptors: fvtxData.vertexAttributeDescriptors,
            vertexBufferDescriptors: fvtxData.inputBufferDescriptors,
        });

        this.vertexBufferDescriptors = fvtxData.vertexBufferDescriptors;
        this.indexBuffer = makeStaticDataBufferFromSlice(cache.device, GfxBufferUsage.Index, mesh.indexBufferData);
        this.indexBufferDescriptor = { buffer: this.indexBuffer, byteOffset: 0 };
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.indexBuffer);
    }
}

export class FSHPData {
    public meshData: FSHPMeshData[] = [];

    constructor(cache: GfxRenderCache, public fshp: FSHP, fvtxData: FVTXData) {
        for (let i = 0; i < fshp.mesh.length; i++)
            this.meshData.push(new FSHPMeshData(cache, fshp.mesh[i], fvtxData));
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.meshData.length; i++)
            this.meshData[i].destroy(device);
    }
}

export class FMDLData {
    public fvtxData: FVTXData[] = [];
    public fshpData: FSHPData[] = [];

    constructor(cache: GfxRenderCache, public fmdl: FMDL) {
        for (let i = 0; i < fmdl.fvtx.length; i++)
            this.fvtxData.push(new FVTXData(cache.device, fmdl.fvtx[i]));
        for (let i = 0; i < fmdl.fshp.length; i++) {
            const fshp = fmdl.fshp[i];
            this.fshpData.push(new FSHPData(cache, fshp, this.fvtxData[fshp.vertexIndex]));
        }
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.fvtxData.length; i++)
            this.fvtxData[i].destroy(device);
        for (let i = 0; i < this.fshpData.length; i++)
            this.fshpData[i].destroy(device);
    }
}

class FSHPMeshInstance {
    constructor(public meshData: FSHPMeshData) {
        assert(this.meshData.mesh.offset === 0);
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        // TODO(jstpierre): Do we have to care about submeshes?
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setDrawCount(this.meshData.mesh.count);
        renderInst.setVertexInput(this.meshData.inputLayout, this.meshData.vertexBufferDescriptors, this.meshData.indexBufferDescriptor);

        const depth = computeViewSpaceDepthFromWorldSpaceAABB(viewerInput.camera.viewMatrix, this.meshData.mesh.bbox);
        renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, depth);
        renderInstManager.submitRenderInst(renderInst);
    }
}

const scratchMatrix = mat4.create();
const bboxScratch = new AABB();
class FSHPInstance {
    private lodMeshInstances: FSHPMeshInstance[] = [];
    public visible = true;

    constructor(public fshpData: FSHPData, private fmatInstance: FMATInstance) {
        // Only construct the first LOD mesh for now.
        for (let i = 0; i < 1; i++)
            this.lodMeshInstances.push(new FSHPMeshInstance(fshpData.meshData[i]));
    }

    public prepareToRender(globals: TurboRenderGlobals, renderInstManager: GfxRenderInstManager, modelMatrix: ReadonlyMat4, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible)
            return;

        if (!this.fmatInstance.inColorPass)
            return;

        // TODO(jstpierre): Joints.
        const template = renderInstManager.pushTemplate();
        this.fmatInstance.setOnRenderInst(globals, template, modelMatrix);

        for (let i = 0; i < this.lodMeshInstances.length; i++) {
            bboxScratch.transform(this.lodMeshInstances[i].meshData.mesh.bbox, modelMatrix);
            if (!viewerInput.camera.frustum.contains(bboxScratch))
                continue;

            this.lodMeshInstances[i].prepareToRender(renderInstManager, viewerInput);
        }

        renderInstManager.popTemplate();
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 11 },
];

export class FMDLRenderer {
    public fmatInst: FMATInstance[] = [];
    public fshpInst: FSHPInstance[] = [];
    public modelMatrix = mat4.create();
    public visible = true;
    public name: string;

    constructor(device: GfxDevice, cache: GfxRenderCache, public textureHolder: BRTITextureHolder, public fmdlData: FMDLData) {
        const fmdl = this.fmdlData.fmdl;
        this.name = fmdl.name;

        for (let i = 0; i < fmdl.fmat.length; i++)
            this.fmatInst.push(new FMATInstance(cache, this.textureHolder, fmdl.fmat[i]));

        for (let i = 0; i < this.fmdlData.fshpData.length; i++) {
            const fshpData = this.fmdlData.fshpData[i];
            const fmatInstance = this.fmatInst[fshpData.fshp.materialIndex];
            this.fshpInst.push(new FSHPInstance(fshpData, fmatInstance));
        }
    }

    public setVisible(v: boolean) {
        this.visible = v;
    }

    public prepareToRender(globals: TurboRenderGlobals, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible)
            return;

        for (let i = 0; i < this.fshpInst.length; i++)
            this.fshpInst[i].prepareToRender(globals, renderInstManager, this.modelMatrix, viewerInput);
    }
}

export class TurboCommonRes {
    public commonGEnv: SARC.SARC;

    public destroy(): void {
    }
}

const scratchColor = colorNewCopy(White);
const scratchVec3 = vec3.create();
export class TurboLightEnv {
    private aglenv: AGLEnv.AGLEnv;
    private agllmap: AGLLightMap.AGLLightMap;
    private useEnvLights = true;
    private lightIntensityScale = 1.0;
    private directionalIsWrapped = true;
    private hemisphereIsWrapped = true;

    constructor(bgenvBuffer: ArrayBufferSlice, commonRes: TurboCommonRes) {
        const bgenv = SARC.parse(bgenvBuffer);
        this.aglenv = AGLEnv.parse(assertExists(bgenv.files.find((p) => p.name.endsWith('course_area.baglenv'))).buffer);

        const bagllmap = bgenv.files.find((p) => p.name.endsWith('.bagllmap'));
        if (bagllmap !== undefined) {
            this.agllmap = AGLLightMap.parse(bagllmap.buffer);
        } else {
            this.agllmap = AGLLightMap.parse(commonRes.commonGEnv.files.find((p) => p.name === 'turbo_cmn.bagllmap')!.buffer);
        }
    }

    public findLightMap(name: string): AGLLightMap.LightMap {
        return this.agllmap.lmap.find((lmap) => lmap.name === name)!;
    }

    private fillEnvLightParamsForLightEnvObj(d: Float32Array, offs: number, lightEnvObj: AGLLightMap.LightEnvObject): number | null {
        let baseOffs = offs;

        // Nothing to do.
        if (lightEnvObj.name === '')
            return null;

        // mip0 = lit, mip1 = unlit

        if (!lightEnvObj.enable_mip0) {
            assert(!lightEnvObj.enable_mip1);
            return null;
        }

        if (!this.useEnvLights)
            return null;

        const visibleInShadow = lightEnvObj.enable_mip1;

        if (lightEnvObj.type === 'AmbientLight') {
            // TODO(jstpierre): Fill this in
            return null;
        } else if (lightEnvObj.type === 'DirectionalLight') {
            const dirLight = assertExists(this.aglenv.DirectionalLight.find((obj) => obj.name === lightEnvObj.name));
            colorScale(scratchColor, dirLight.BacksideColor, dirLight.Intensity * this.lightIntensityScale);
            const wrapped = this.directionalIsWrapped;
            scratchColor.a = wrapped ? 1.0 : 0.0;
            offs += fillColor(d, offs, scratchColor);
            colorScale(scratchColor, dirLight.DiffuseColor, dirLight.Intensity * this.lightIntensityScale);
            scratchColor.a = visibleInShadow ? 1.0 : 0.0;
            offs += fillColor(d, offs, scratchColor);
            offs += fillVec3v(d, offs, dirLight.Direction);
        } else if (lightEnvObj.type === 'HemisphereLight') {
            const hemiLight = assertExists(this.aglenv.HemisphereLight.find((obj) => obj.name === lightEnvObj.name));
            colorScale(scratchColor, hemiLight.GroundColor, hemiLight.Intensity * this.lightIntensityScale);
            const wrapped = this.hemisphereIsWrapped;
            scratchColor.a = wrapped ? 1.0 : 0.0;
            offs += fillColor(d, offs, scratchColor);
            colorScale(scratchColor, hemiLight.SkyColor, hemiLight.Intensity * this.lightIntensityScale);
            scratchColor.a = visibleInShadow ? 1.0 : 0.0;
            offs += fillColor(d, offs, scratchColor);
            vec3.negate(scratchVec3, hemiLight.Direction);
            offs += fillVec3v(d, offs, scratchVec3);
        } else {
            throw "whoops";
        }

        return offs - baseOffs;
    }

    public fillEnvLightParamsForMap(d: Float32Array, offs: number, lightMap: AGLLightMap.LightMap, numLights: number): number {
        const baseOffs = offs;
        for (let i = 0; i < lightMap.env_obj_ref_array.length; i++) {
            const filled = this.fillEnvLightParamsForLightEnvObj(d, offs, lightMap.env_obj_ref_array[i]);
            if (filled === null)
                continue;
            offs += filled;

            if (numLights-- === 0)
                break;
        }

        for (let i = 0; i < numLights; i++) {
            offs += fillColor(d, offs, OpaqueBlack);
            offs += fillVec3v(d, offs, Vec3Zero);
        }

        return offs - baseOffs;
    }
}

export class TurboRenderGlobals {
    public lightEnv: TurboLightEnv;
    public textureHolder: BRTITextureHolder;

    public destroy(device: GfxDevice): void {
        this.textureHolder.destroy(device);
    }
}

export class TurboRenderer {
    public renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    public fmdlRenderers: FMDLRenderer[] = [];
    public textureHolder: BRTITextureHolder;

    constructor(device: GfxDevice, public globals: TurboRenderGlobals) {
        this.renderHelper = new GfxRenderHelper(device);
        this.textureHolder = this.globals.textureHolder;
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const renderInstManager = this.renderHelper.renderInstManager;

        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        let offs = template.allocateUniformBuffer(TurboUBER.ub_SceneParams, 16+4);
        const d = template.mapUniformBufferF32(TurboUBER.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, viewerInput.camera.clipFromWorldMatrix);
        getMatrixTranslation(scratchVec3, viewerInput.camera.worldMatrix);
        offs += fillVec3v(d, offs, scratchVec3);

        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);

        for (let i = 0; i < this.fmdlRenderers.length; i++)
            this.fmdlRenderers[i].prepareToRender(this.globals, renderInstManager, viewerInput);
        this.renderHelper.renderInstManager.popTemplate();

        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        this.renderInstListMain.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        this.globals.destroy(device);
    }
}
