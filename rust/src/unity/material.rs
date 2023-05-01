use crate::unity::asset::*;
use crate::unity::mesh::Vec2f;
use crate::unity::reader::*;
use crate::unity::version::UnityVersion;
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug)]
pub struct UnityMaterial {
    pub name: String,
    pub shader: PPtr,
    pub keywords: String,
    pub saved_properties: UnityPropertySheet,
}

type StringTagMap = Map<String, String>;

impl Deserialize for UnityMaterial {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let name = reader.read_char_array()?;
        let shader = PPtr::deserialize(reader, asset)?;
        let keywords = reader.read_char_array()?;

        let _lightmap_flags = reader.read_u32()?;
        let _enable_instancing_variants = reader.read_bool()?;
        let _double_sided_gi = reader.read_bool()?;
        reader.align()?;

        let _custom_render_queue = reader.read_i32()?;

        let _string_tag_map = StringTagMap::deserialize(reader, asset)?;
        let _disabled_shader_passes = String::deserialize_array(reader, asset)?;

        let saved_properties = UnityPropertySheet::deserialize(reader, asset)?;

        Ok(UnityMaterial {
            name,
            shader,
            keywords,
            saved_properties,
        })
    }
}

#[wasm_bindgen]
impl UnityMaterial {
    pub fn from_bytes(
        data: Vec<u8>,
        asset: &AssetInfo,
    ) -> std::result::Result<UnityMaterial, String> {
        let mut reader = AssetReader::new(data);
        reader.set_endianness(asset.header.endianness);
        UnityMaterial::deserialize(&mut reader, asset).map_err(|err| format!("{:?}", err))
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct ColorRGBAf {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Deserialize for ColorRGBAf {
    fn deserialize(reader: &mut AssetReader, _asset: &AssetInfo) -> Result<Self> {
        Ok(ColorRGBAf {
            r: reader.read_f32()?,
            g: reader.read_f32()?,
            b: reader.read_f32()?,
            a: reader.read_f32()?,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityTexEnv {
    pub texture: PPtr,
    pub scale: Vec2f,
    pub offset: Vec2f,
}

impl Deserialize for UnityTexEnv {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let texture = PPtr::deserialize(reader, asset)?;
        let scale = Vec2f::deserialize(reader, asset)?;
        let offset = Vec2f::deserialize(reader, asset)?;
        Ok(UnityTexEnv {
            texture,
            offset,
            scale,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityPropertySheet {
    tex_envs: Map<String, UnityTexEnv>,
    floats: Map<String, f32>,
    colors: Map<String, ColorRGBAf>,
}

#[wasm_bindgen]
impl UnityPropertySheet {
    pub fn get_tex_env_count(&self) -> usize {
        self.tex_envs.keys.len()
    }

    pub fn get_tex_env_name(&self, idx: usize) -> String {
        self.tex_envs.keys[idx].clone()
    }

    pub fn get_tex_env(&self, idx: usize) -> Option<UnityTexEnv> {
        Some(self.tex_envs.vals[idx].clone())
    }

    pub fn find_tex_env(&self, name: String) -> Option<UnityTexEnv> {
        self.tex_envs.find(name)
    }

    pub fn get_float_count(&self) -> usize {
        self.floats.keys.len()
    }

    pub fn get_float_name(&self, idx: usize) -> String {
        self.floats.keys[idx].clone()
    }

    pub fn get_float(&self, idx: usize) -> f32 {
        self.floats.vals[idx]
    }

    pub fn get_color_count(&self) -> usize {
        self.colors.keys.len()
    }

    pub fn get_color_name(&self, idx: usize) -> String {
        self.colors.keys[idx].clone()
    }

    pub fn get_color(&self, idx: usize) -> ColorRGBAf {
        self.colors.vals[idx].clone()
    }
}

impl Deserialize for UnityPropertySheet {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        type TexEnvMap = Map<String, UnityTexEnv>;
        let tex_envs = TexEnvMap::deserialize(reader, asset)?;

        type FloatMap = Map<String, f32>;
        let floats = FloatMap::deserialize(reader, asset)?;

        type ColorMap = Map<String, ColorRGBAf>;
        let colors = ColorMap::deserialize(reader, asset)?;
        Ok(UnityPropertySheet {
            tex_envs,
            floats,
            colors,
        })
    }
}

#[derive(Debug)]
struct UnityShaderSerializedTextureProperty {
    pub name: String,
    pub dimension: u32,
}

impl Deserialize for UnityShaderSerializedTextureProperty {
    fn deserialize(reader: &mut AssetReader, _asset: &AssetInfo) -> Result<Self> {
        let name = reader.read_char_array()?;
        let dimension = reader.read_u32()?;

        Ok(UnityShaderSerializedTextureProperty { name, dimension })
    }
}

#[derive(Debug)]
struct UnityShaderSerializedProperty {
    pub name: String,
    pub description: String,
    pub attributes: Vec<String>,
    pub prop_type: u32,
    pub flags: u32,
    pub def_value: [f32; 4],
    pub def_texture: UnityShaderSerializedTextureProperty,
}

impl Deserialize for UnityShaderSerializedProperty {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let name = reader.read_char_array()?;
        let description = reader.read_char_array()?;
        let attributes = String::deserialize_array(reader, asset)?;
        let prop_type = reader.read_u32()?;
        let flags = reader.read_u32()?;
        let def_value = [
            reader.read_f32()?,
            reader.read_f32()?,
            reader.read_f32()?,
            reader.read_f32()?,
        ];
        let def_texture = UnityShaderSerializedTextureProperty::deserialize(reader, asset)?;

        Ok(UnityShaderSerializedProperty {
            name,
            description,
            attributes,
            prop_type,
            flags,
            def_value,
            def_texture,
        })
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub enum UnityShaderPassType {
    Normal,
    Use,
    Grab,
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug, Clone)]
pub struct UnityShaderSerializedShaderFloatValue {
    pub val: f32,
    pub name: String,
}

impl Deserialize for UnityShaderSerializedShaderFloatValue {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSerializedShaderFloatValue {
            val: reader.read_f32()?,
            name: reader.read_char_array()?,
        })
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug, Clone)]
pub struct UnityShaderSerializedShaderRTBlendState {
    pub src_blend: UnityShaderSerializedShaderFloatValue,
    pub dest_blend: UnityShaderSerializedShaderFloatValue,
    pub src_blend_alpha: UnityShaderSerializedShaderFloatValue,
    pub dest_blend_alpha: UnityShaderSerializedShaderFloatValue,
    pub blend_op: UnityShaderSerializedShaderFloatValue,
    pub blend_op_alpha: UnityShaderSerializedShaderFloatValue,
    pub col_mask: UnityShaderSerializedShaderFloatValue,
}

impl Deserialize for UnityShaderSerializedShaderRTBlendState {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSerializedShaderRTBlendState {
            src_blend: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            dest_blend: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            src_blend_alpha: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            dest_blend_alpha: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            blend_op: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            blend_op_alpha: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            col_mask: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
        })
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug, Clone)]
pub struct UnityShaderSerializedStencilOp {
    pub pass: UnityShaderSerializedShaderFloatValue,
    pub fail: UnityShaderSerializedShaderFloatValue,
    pub z_fail: UnityShaderSerializedShaderFloatValue,
    pub comp: UnityShaderSerializedShaderFloatValue,
}

impl Deserialize for UnityShaderSerializedStencilOp {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSerializedStencilOp {
            pass: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            fail: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            z_fail: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            comp: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
        })
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug, Clone)]
pub struct UnityShaderSerializedShaderVectorValue {
    pub x: UnityShaderSerializedShaderFloatValue,
    pub y: UnityShaderSerializedShaderFloatValue,
    pub z: UnityShaderSerializedShaderFloatValue,
    pub w: UnityShaderSerializedShaderFloatValue,
    pub name: String,
}

impl Deserialize for UnityShaderSerializedShaderVectorValue {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSerializedShaderVectorValue {
            x: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            y: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            z: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            w: UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?,
            name: reader.read_char_array()?,
        })
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub enum UnityShaderFogMode {
    Unknown,
    Disabled,
    Linear,
    Exp,
    Exp2,
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug, Clone)]
pub struct UnityShaderSerializedShaderState {
    pub name: String,
    rt_blend: [UnityShaderSerializedShaderRTBlendState; 8],
    pub rt_separate_blend: bool,
    pub z_clip: Option<UnityShaderSerializedShaderFloatValue>,
    pub z_test: UnityShaderSerializedShaderFloatValue,
    pub z_write: UnityShaderSerializedShaderFloatValue,
    pub culling: UnityShaderSerializedShaderFloatValue,
    pub conservative: Option<UnityShaderSerializedShaderFloatValue>,
    pub offset_factor: UnityShaderSerializedShaderFloatValue,
    pub offset_units: UnityShaderSerializedShaderFloatValue,
    pub alpha_to_mask: UnityShaderSerializedShaderFloatValue,
    pub stencil_op: UnityShaderSerializedStencilOp,
    pub stencil_op_front: UnityShaderSerializedStencilOp,
    pub stencil_op_back: UnityShaderSerializedStencilOp,
    pub stencil_read_mask: UnityShaderSerializedShaderFloatValue,
    pub stencil_write_mask: UnityShaderSerializedShaderFloatValue,
    pub stencil_ref: UnityShaderSerializedShaderFloatValue,
    pub fog_start: UnityShaderSerializedShaderFloatValue,
    pub fog_end: UnityShaderSerializedShaderFloatValue,
    pub fog_density: UnityShaderSerializedShaderFloatValue,
    pub fog_color: UnityShaderSerializedShaderVectorValue,
    pub fog_mode: UnityShaderFogMode,
    pub gpu_program_id: i32,
    tags: StringTagMap,
    pub lod: i32,
    pub lighting: bool,
}

#[wasm_bindgen]
impl UnityShaderSerializedShaderState {
    pub fn get_fog_mode(value: i32) -> UnityShaderFogMode {
        match value {
            -1 => UnityShaderFogMode::Unknown,
            0 => UnityShaderFogMode::Disabled,
            1 => UnityShaderFogMode::Linear,
            2 => UnityShaderFogMode::Exp,
            3 => UnityShaderFogMode::Exp2,
            _ => panic!("unrecognized fog mode {}", value),
        }
    }
}

impl Deserialize for UnityShaderSerializedShaderState {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let name = reader.read_char_array()?;
        let rt_blend = [
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
            UnityShaderSerializedShaderRTBlendState::deserialize(reader, asset)?,
        ];
        let rt_separate_blend = reader.read_bool()?;
        reader.align()?;
        let z_clip = if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2017,
                minor: 2,
                ..Default::default()
            }) {
            Some(UnityShaderSerializedShaderFloatValue::deserialize(
                reader, asset,
            )?)
        } else {
            None
        };
        let z_test = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let z_write = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let culling = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let conservative = if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2020,
                ..Default::default()
            }) {
            Some(UnityShaderSerializedShaderFloatValue::deserialize(
                reader, asset,
            )?)
        } else {
            None
        };
        let offset_factor = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let offset_units = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let alpha_to_mask = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let stencil_op = UnityShaderSerializedStencilOp::deserialize(reader, asset)?;
        let stencil_op_front = UnityShaderSerializedStencilOp::deserialize(reader, asset)?;
        let stencil_op_back = UnityShaderSerializedStencilOp::deserialize(reader, asset)?;
        let stencil_read_mask = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let stencil_write_mask = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let stencil_ref = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let fog_start = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let fog_end = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let fog_density = UnityShaderSerializedShaderFloatValue::deserialize(reader, asset)?;
        let fog_color = UnityShaderSerializedShaderVectorValue::deserialize(reader, asset)?;
        let fog_mode = UnityShaderSerializedShaderState::get_fog_mode(reader.read_i32()?);
        let gpu_program_id = reader.read_i32()?;
        let tags = StringTagMap::deserialize(reader, asset)?;
        let lod = reader.read_i32()?;
        let lighting = reader.read_bool()?;
        reader.align()?;
        Ok(UnityShaderSerializedShaderState {
            name,
            rt_blend,
            rt_separate_blend,
            z_clip,
            z_test,
            z_write,
            culling,
            conservative,
            offset_factor,
            offset_units,
            alpha_to_mask,
            stencil_op,
            stencil_op_front,
            stencil_op_back,
            stencil_read_mask,
            stencil_write_mask,
            stencil_ref,
            fog_start,
            fog_end,
            fog_density,
            fog_color,
            fog_mode,
            gpu_program_id,
            tags,
            lod,
            lighting,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderBindChannel {
    source: u8,
    target: u8,
}

impl Deserialize for UnityShaderBindChannel {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderBindChannel {
            source: reader.read_u8()?,
            target: reader.read_u8()?,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderParserBindChannels {
    channels: Vec<UnityShaderBindChannel>,
    source_map: u32,
}

impl Deserialize for UnityShaderParserBindChannels {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let channels = UnityShaderBindChannel::deserialize_array(reader, asset)?;
        let source_map = reader.read_u32()?;
        Ok(UnityShaderParserBindChannels {
            channels,
            source_map,
        })
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub enum UnityShaderGpuProgramType {
    Unknown,
    GLLegacy,
    GLES31AEP,
    GLES31,
    GLES3,
    GLES,
    GLCore32,
    GLCore41,
    GLCore43,
    DX9VertexSM20,
    DX9VertexSM30,
    DX9PixelSM20,
    DX9PixelSM30,
    DX10Level9Vertex,
    DX10Level9Pixel,
    DX11VertexSM40,
    DX11VertexSM50,
    DX11PixelSM40,
    DX11PixelSM50,
    DX11GeometrySM40,
    DX11GeometrySM50,
    DX11HullSM50,
    DX11DomainSM50,
    MetalVS,
    MetalFS,
    SPIRV,
    ConsoleVS,
    ConsoleFS,
    ConsoleHS,
    ConsoleDS,
    ConsoleGS,
    RayTracing,
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderVectorParameter {
    pub name_index: i32,
    pub index: i32,
    pub array_size: i32,
    pub typ: u8,
    pub dim: u8,
}

impl Deserialize for UnityShaderVectorParameter {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let name_index = reader.read_i32()?;
        let index = reader.read_i32()?;
        let array_size = reader.read_i32()?;
        let typ = reader.read_u8()?;
        let dim = reader.read_u8()?;
        reader.align()?;
        Ok(UnityShaderVectorParameter {
            name_index,
            index,
            array_size,
            typ,
            dim,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderMatrixParameter {
    pub name_index: i32,
    pub index: i32,
    pub array_size: i32,
    pub typ: u8,
    pub row_count: u8,
}

impl Deserialize for UnityShaderMatrixParameter {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let name_index = reader.read_i32()?;
        let index = reader.read_i32()?;
        let array_size = reader.read_i32()?;
        let typ = reader.read_u8()?;
        let row_count = reader.read_u8()?;
        reader.align()?;
        Ok(UnityShaderMatrixParameter {
            name_index,
            index,
            array_size,
            typ,
            row_count,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderTextureParameter {
    pub name_index: i32,
    pub index: i32,
    pub sampler_index: i32,
    pub multi_sampled: Option<bool>,
    pub dim: u8,
}

impl Deserialize for UnityShaderTextureParameter {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let name_index = reader.read_i32()?;
        let index = reader.read_i32()?;
        let sampler_index = reader.read_i32()?;
        let multi_sampled = if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2017,
                minor: 3,
                ..Default::default()
            }) {
            Some(reader.read_bool()?)
        } else {
            None
        };
        let dim = reader.read_u8()?;
        reader.align()?;
        Ok(UnityShaderTextureParameter {
            name_index,
            index,
            sampler_index,
            multi_sampled,
            dim,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderBufferBinding {
    pub name_index: i32,
    pub index: i32,
    pub array_size: Option<i32>,
}

impl Deserialize for UnityShaderBufferBinding {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderBufferBinding {
            name_index: reader.read_i32()?,
            index: reader.read_i32()?,
            array_size: if asset.metadata.unity_version
                >= (UnityVersion {
                    major: 2020,
                    ..Default::default()
                }) {
                Some(reader.read_i32()?)
            } else {
                None
            },
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderStructParameter {
    pub name_index: i32,
    pub index: i32,
    pub array_size: i32,
    pub struct_size: i32,
    vector_params: Vec<UnityShaderVectorParameter>,
    matrix_params: Vec<UnityShaderMatrixParameter>,
}

impl Deserialize for UnityShaderStructParameter {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderStructParameter {
            name_index: reader.read_i32()?,
            index: reader.read_i32()?,
            array_size: reader.read_i32()?,
            struct_size: reader.read_i32()?,
            vector_params: UnityShaderVectorParameter::deserialize_array(reader, asset)?,
            matrix_params: UnityShaderMatrixParameter::deserialize_array(reader, asset)?,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderConstantBuffer {
    pub name_index: i32,
    matrix_params: Vec<UnityShaderMatrixParameter>,
    vector_params: Vec<UnityShaderVectorParameter>,
    struct_params: Option<Vec<UnityShaderStructParameter>>,
    pub size: i32,
    pub is_partial_cb: Option<bool>,
}

impl Deserialize for UnityShaderConstantBuffer {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let unity_version = asset.metadata.unity_version;
        let name_index = reader.read_i32()?;
        let matrix_params = UnityShaderMatrixParameter::deserialize_array(reader, asset)?;
        let vector_params = UnityShaderVectorParameter::deserialize_array(reader, asset)?;
        let struct_params = if unity_version
            >= (UnityVersion {
                major: 2017,
                minor: 3,
                ..Default::default()
            }) {
            Some(UnityShaderStructParameter::deserialize_array(
                reader, asset,
            )?)
        } else {
            None
        };
        let size = reader.read_i32()?;

        let mut is_partial_cb: Option<bool> = None;
        if unity_version
            >= (UnityVersion {
                major: 2021,
                minor: 1,
                build: 4,
                ..Default::default()
            })
            || (unity_version.major == 2020
                && unity_version
                    >= (UnityVersion {
                        major: 2020,
                        minor: 3,
                        build: 2,
                        ..Default::default()
                    }))
        {
            is_partial_cb = Some(reader.read_bool()?);
            reader.align()?;
        }
        Ok(UnityShaderConstantBuffer {
            name_index,
            matrix_params,
            vector_params,
            struct_params,
            size,
            is_partial_cb,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderUAVParameter {
    pub name_index: i32,
    pub index: i32,
    pub original_index: i32,
}

impl Deserialize for UnityShaderUAVParameter {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderUAVParameter {
            name_index: reader.read_i32()?,
            index: reader.read_i32()?,
            original_index: reader.read_i32()?,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderSamplerParameter {
    pub sampler: u32,
    pub bind_point: i32,
}

impl Deserialize for UnityShaderSamplerParameter {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSamplerParameter {
            sampler: reader.read_u32()?,
            bind_point: reader.read_i32()?,
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderSerializedProgramParameters {
    vector_params: Vec<UnityShaderVectorParameter>,
    matrix_params: Vec<UnityShaderMatrixParameter>,
    texture_params: Vec<UnityShaderTextureParameter>,
    buffer_params: Vec<UnityShaderBufferBinding>,
    constant_buffers: Vec<UnityShaderConstantBuffer>,
    constant_buffer_bindings: Vec<UnityShaderBufferBinding>,
    uav_params: Vec<UnityShaderUAVParameter>,
    samplers: Option<Vec<UnityShaderSamplerParameter>>,
}

impl Deserialize for UnityShaderSerializedProgramParameters {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSerializedProgramParameters {
            vector_params: UnityShaderVectorParameter::deserialize_array(reader, asset)?,
            matrix_params: UnityShaderMatrixParameter::deserialize_array(reader, asset)?,
            texture_params: UnityShaderTextureParameter::deserialize_array(reader, asset)?,
            buffer_params: UnityShaderBufferBinding::deserialize_array(reader, asset)?,
            constant_buffers: UnityShaderConstantBuffer::deserialize_array(reader, asset)?,
            constant_buffer_bindings: UnityShaderBufferBinding::deserialize_array(reader, asset)?,
            uav_params: UnityShaderUAVParameter::deserialize_array(reader, asset)?,
            samplers: if asset.metadata.unity_version
                >= (UnityVersion {
                    major: 2017,
                    ..Default::default()
                }) {
                Some(UnityShaderSamplerParameter::deserialize_array(
                    reader, asset,
                )?)
            } else {
                None
            },
        })
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen(getter_with_clone)]
pub struct UnityShaderSerializedSubProgram {
    pub blob_index: u32,
    pub channels: UnityShaderParserBindChannels,
    pub global_keyword_indices: Option<Vec<u16>>,
    pub local_keyword_indices: Option<Vec<u16>>,
    pub keyword_indices: Option<Vec<u16>>,
    pub shader_hardware_tier: u8,
    pub gpu_program_type: UnityShaderGpuProgramType,
    pub parameters: Option<UnityShaderSerializedProgramParameters>,
    pub shader_requirements: Option<i64>,
}

#[wasm_bindgen]
impl UnityShaderSerializedSubProgram {
    pub fn get_gpu_program_type(value: u8) -> UnityShaderGpuProgramType {
        match value {
            0 => UnityShaderGpuProgramType::Unknown,
            1 => UnityShaderGpuProgramType::GLLegacy,
            2 => UnityShaderGpuProgramType::GLES31AEP,
            3 => UnityShaderGpuProgramType::GLES31,
            4 => UnityShaderGpuProgramType::GLES3,
            5 => UnityShaderGpuProgramType::GLES,
            6 => UnityShaderGpuProgramType::GLCore32,
            7 => UnityShaderGpuProgramType::GLCore41,
            8 => UnityShaderGpuProgramType::GLCore43,
            9 => UnityShaderGpuProgramType::DX9VertexSM20,
            10 => UnityShaderGpuProgramType::DX9VertexSM30,
            11 => UnityShaderGpuProgramType::DX9PixelSM20,
            12 => UnityShaderGpuProgramType::DX9PixelSM30,
            13 => UnityShaderGpuProgramType::DX10Level9Vertex,
            14 => UnityShaderGpuProgramType::DX10Level9Pixel,
            15 => UnityShaderGpuProgramType::DX11VertexSM40,
            16 => UnityShaderGpuProgramType::DX11VertexSM50,
            17 => UnityShaderGpuProgramType::DX11PixelSM40,
            18 => UnityShaderGpuProgramType::DX11PixelSM50,
            19 => UnityShaderGpuProgramType::DX11GeometrySM40,
            20 => UnityShaderGpuProgramType::DX11GeometrySM50,
            21 => UnityShaderGpuProgramType::DX11HullSM50,
            22 => UnityShaderGpuProgramType::DX11DomainSM50,
            23 => UnityShaderGpuProgramType::MetalVS,
            24 => UnityShaderGpuProgramType::MetalFS,
            25 => UnityShaderGpuProgramType::SPIRV,
            26 => UnityShaderGpuProgramType::ConsoleVS,
            27 => UnityShaderGpuProgramType::ConsoleFS,
            28 => UnityShaderGpuProgramType::ConsoleHS,
            29 => UnityShaderGpuProgramType::ConsoleDS,
            30 => UnityShaderGpuProgramType::ConsoleGS,
            31 => UnityShaderGpuProgramType::RayTracing,
            _ => panic!("unrecognized GPU program type {}", value),
        }
    }
}

impl Deserialize for UnityShaderSerializedSubProgram {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let unity_version = asset.metadata.unity_version;
        let mut myself = UnityShaderSerializedSubProgram {
            blob_index: reader.read_u32()?,
            channels: UnityShaderParserBindChannels::deserialize(reader, asset)?,
            global_keyword_indices: None,
            local_keyword_indices: None,
            keyword_indices: None,
            shader_hardware_tier: 0,
            gpu_program_type: UnityShaderGpuProgramType::Unknown,
            parameters: None,
            shader_requirements: None,
        };

        if (UnityVersion {
            major: 2019,
            ..Default::default()
        }) <= unity_version
            && unity_version
                < (UnityVersion {
                    major: 2021,
                    minor: 2,
                    ..Default::default()
                })
        {
            myself.global_keyword_indices = Some(reader.read_u16_array()?);
            reader.align()?;
            myself.local_keyword_indices = Some(reader.read_u16_array()?);
            reader.align()?;
        } else {
            myself.keyword_indices = Some(reader.read_u16_array()?);
            if unity_version
                >= (UnityVersion {
                    major: 2017,
                    ..Default::default()
                })
            {
                reader.align()?;
            }
        }

        myself.shader_hardware_tier = reader.read_u8()?;
        myself.gpu_program_type =
            UnityShaderSerializedSubProgram::get_gpu_program_type(reader.read_u8()?);
        reader.align()?;

        myself.parameters = Some(UnityShaderSerializedProgramParameters::deserialize(
            reader, asset,
        )?);

        myself.shader_requirements = if unity_version
            >= (UnityVersion {
                major: 2017,
                minor: 2,
                ..Default::default()
            }) {
            Some(
                if unity_version
                    >= (UnityVersion {
                        major: 2021,
                        ..Default::default()
                    })
                {
                    reader.read_i64()?
                } else {
                    reader.read_i32()?.into()
                },
            )
        } else {
            None
        };
        Ok(myself)
    }
}

#[derive(Debug, Clone)]
#[wasm_bindgen]
pub struct UnityShaderSerializedProgram {
    sub_programs: Vec<UnityShaderSerializedSubProgram>,
    common_parameters: Option<UnityShaderSerializedProgramParameters>,
}

impl Deserialize for UnityShaderSerializedProgram {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSerializedProgram {
            sub_programs: UnityShaderSerializedSubProgram::deserialize_array(reader, asset)?,
            common_parameters: if asset.metadata.unity_version
                >= (UnityVersion {
                    major: 2021,
                    minor: 1,
                    build: 4,
                    ..Default::default()
                })
                || (asset.metadata.unity_version.major == 2020
                    && asset.metadata.unity_version
                        >= (UnityVersion {
                            major: 2020,
                            minor: 3,
                            build: 2,
                            ..Default::default()
                        })) {
                Some(UnityShaderSerializedProgramParameters::deserialize(
                    reader, asset,
                )?)
            } else {
                None
            },
        })
    }
}

#[derive(Debug)]
struct Hash128 {
    value: [u8; 16],
}

impl Deserialize for Hash128 {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let mut ret = Hash128 { value: [0; 16] };
        for i in 0..16 {
            ret.value[i] = reader.read_u8()?;
        }
        Ok(ret)
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug, Clone)]
pub struct UnityShaderSerializedPass {
    name_indices: Map<String, i32>,
    pub typ: UnityShaderPassType,
    pub state: UnityShaderSerializedShaderState,
    pub program_mask: u32,
    pub prog_vertex: UnityShaderSerializedProgram,
    pub prog_fragment: UnityShaderSerializedProgram,
    pub prog_geometry: UnityShaderSerializedProgram,
    pub prog_hull: UnityShaderSerializedProgram,
    pub prog_domain: UnityShaderSerializedProgram,
    pub prog_ray_tracing: Option<UnityShaderSerializedProgram>,
    pub has_instancing_variant: bool,
    pub has_procedural_instancing_variant: Option<bool>,
    pub use_name: String,
    pub name: String,
    pub texture_name: String,
    tags: StringTagMap,
    pub serialized_keyword_state_mask: Option<Vec<u16>>,
}

#[wasm_bindgen]
impl UnityShaderSerializedPass {
    pub fn get_pass_type(value: i32) -> UnityShaderPassType {
        match value {
            0 => UnityShaderPassType::Normal,
            1 => UnityShaderPassType::Use,
            2 => UnityShaderPassType::Grab,
            _ => panic!("unrecognized pass type {}", value),
        }
    }
}

impl Deserialize for UnityShaderSerializedPass {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2020,
                minor: 2,
                ..Default::default()
            })
        {
            let _editor_data_hash = Hash128::deserialize_array(reader, asset)?;
            reader.align()?;
            let _platforms = reader.read_byte_array()?;
            reader.align()?;
            if asset.metadata.unity_version
                < (UnityVersion {
                    major: 2021,
                    minor: 2,
                    ..Default::default()
                })
            {
                let _local_keyword_mask = reader.read_u16_array()?;
                reader.align()?;
                let _global_keyword_mask = reader.read_u16_array()?;
                reader.align()?;
            }
        }
        type NameIndicesMap = Map<String, i32>;
        let name_indices = NameIndicesMap::deserialize(reader, asset)?;
        let typ = UnityShaderSerializedPass::get_pass_type(reader.read_i32()?);
        let state = UnityShaderSerializedShaderState::deserialize(reader, asset)?;
        let program_mask = reader.read_u32()?;
        let prog_vertex = UnityShaderSerializedProgram::deserialize(reader, asset)?;
        let prog_fragment = UnityShaderSerializedProgram::deserialize(reader, asset)?;
        let prog_geometry = UnityShaderSerializedProgram::deserialize(reader, asset)?;
        let prog_hull = UnityShaderSerializedProgram::deserialize(reader, asset)?;
        let prog_domain = UnityShaderSerializedProgram::deserialize(reader, asset)?;
        let prog_ray_tracing = if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2019,
                minor: 3,
                ..Default::default()
            }) {
            Some(UnityShaderSerializedProgram::deserialize(reader, asset)?)
        } else {
            None
        };
        let has_instancing_variant = reader.read_bool()?;
        let has_procedural_instancing_variant = if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2018,
                ..Default::default()
            }) {
            Some(reader.read_bool()?)
        } else {
            None
        };
        reader.align()?;
        let use_name = reader.read_char_array()?;
        let name = reader.read_char_array()?;
        let texture_name = reader.read_char_array()?;
        let tags = StringTagMap::deserialize(reader, asset)?;
        let serialized_keyword_state_mask = if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2021,
                minor: 2,
                ..Default::default()
            }) {
            Some(reader.read_u16_array()?)
        } else {
            None
        };
        if asset.metadata.unity_version
            >= (UnityVersion {
                major: 2021,
                minor: 2,
                ..Default::default()
            })
        {
            reader.align()?;
        }
        Ok(UnityShaderSerializedPass {
            name_indices,
            typ,
            state,
            program_mask,
            prog_vertex,
            prog_fragment,
            prog_geometry,
            prog_hull,
            prog_domain,
            prog_ray_tracing,
            has_instancing_variant,
            has_procedural_instancing_variant,
            use_name,
            name,
            texture_name,
            tags,
            serialized_keyword_state_mask,
        })
    }
}

#[derive(Debug)]
#[wasm_bindgen]
pub struct UnityShaderSerializedSubShader {
    passes: Vec<UnityShaderSerializedPass>,
    tags: StringTagMap,
    pub lod: i32,
}

impl Deserialize for UnityShaderSerializedSubShader {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(UnityShaderSerializedSubShader {
            passes: UnityShaderSerializedPass::deserialize_array(reader, asset)?,
            tags: StringTagMap::deserialize(reader, asset)?,
            lod: reader.read_i32()?,
        })
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Debug)]
pub struct UnityShader {
    pub name: String,
    props: Vec<UnityShaderSerializedProperty>,
    sub_shaders: Vec<UnityShaderSerializedSubShader>,
}

impl Deserialize for UnityShader {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let name = reader.read_char_array()?;

        // SerializedShader
        let props = UnityShaderSerializedProperty::deserialize_array(reader, asset)?;
        let sub_shaders = UnityShaderSerializedSubShader::deserialize_array(reader, asset)?;
        // let keyword_data = UnityShaderKeywordNames::deserialize(reader, asset)?;

        Ok(UnityShader {
            name,
            props,
            sub_shaders,
        })
    }
}

#[wasm_bindgen]
impl UnityShader {
    pub fn from_bytes(
        data: Vec<u8>,
        asset: &AssetInfo,
    ) -> std::result::Result<UnityShader, String> {
        let mut reader = AssetReader::new(data);
        reader.set_endianness(asset.header.endianness);
        UnityShader::deserialize(&mut reader, asset).map_err(|err| format!("{:?}", err))
    }
}
