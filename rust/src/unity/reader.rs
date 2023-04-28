use wasm_bindgen::prelude::wasm_bindgen;

use byteorder::{BigEndian, LittleEndian, ReadBytesExt};
use std::convert::From;
use std::convert::TryFrom;
use std::convert::TryInto;
use std::io::prelude::*;
use std::io::Cursor;
use std::io::SeekFrom;
use std::marker::Sized;

use crate::unity::asset::*;
use crate::unity::version::*;

#[derive(Debug)]
pub enum AssetReaderError {
    MissingType(i32),
    IO(std::io::Error),
    UnsupportedFileVersion(u32),
    UnsupportedUnityVersion(UnityVersion),
    UnsupportedFeature(String),
    InvalidVersion(VersionParseError),
    DeserializationError(String),
}

impl From<VersionParseError> for AssetReaderError {
    fn from(err: VersionParseError) -> Self {
        AssetReaderError::InvalidVersion(err)
    }
}

impl From<std::io::Error> for AssetReaderError {
    fn from(err: std::io::Error) -> Self {
        AssetReaderError::IO(err)
    }
}

impl From<AssetReaderError> for String {
    fn from(err: AssetReaderError) -> Self {
        format!("{:?}", err)
    }
}

pub type Result<T> = std::result::Result<T, AssetReaderError>;

pub trait Deserialize {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self>
    where
        Self: Sized;

    fn deserialize_array(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Vec<Self>>
    where
        Self: Sized,
    {
        let n = reader.read_i32()?;
        let mut result = Vec::new();
        for _ in 0..n {
            result.push(Self::deserialize(reader, asset)?);
        }
        // do we need to align the reader here?
        reader.align()?;
        Ok(result)
    }
}

#[wasm_bindgen]
pub struct AssetReader {
    data: Cursor<Vec<u8>>,
    endianness: Endianness,
}

struct TypeTreeNode {
    typ: Option<String>,
    name: Option<String>,
    byte_size: i32,
    index: Option<i32>,
    version: i32,
    meta_flag: Option<i32>,
    level: u8,
    type_str_offset: Option<u32>,
    name_str_offset: Option<u32>,
    ref_type_hash: Option<u64>,
    type_flags: i32,
    variable_count: Option<i32>,
}

// This only supports asset format versions 20, 21, and 22
impl AssetReader {
    pub fn new(data: Vec<u8>) -> AssetReader {
        AssetReader {
            data: Cursor::new(data),
            endianness: Endianness::Big,
        }
    }

    pub fn read_asset_info(&mut self) -> Result<AssetInfo> {
        let header = self.read_header()?;
        self.set_endianness(header.endianness);
        let metadata = self.read_metadata(header.version)?;
        let objects = self.read_objects(&header, &metadata)?;
        let script_types = if header.version >= 11 {
            self.read_script_types()?
        } else {
            Vec::<ScriptType>::new()
        };
        let externals = self.read_externals()?;
        let ref_types = if header.version >= 20 {
            self.read_ref_types(&metadata, header.version)?
        } else {
            Vec::<SerializedType>::new()
        };
        let user_information = if header.version >= 5 {
            self.read_null_terminated_string()?
        } else {
            "".to_string()
        };
        Ok(AssetInfo {
            header,
            metadata,
            objects,
            script_types,
            externals,
            ref_types,
            user_information,
        })
    }

    // align to nearest 4 byte boundary
    pub fn align(&mut self) -> Result<()> {
        let idx = self.data.stream_position()?;
        self.seek(SeekFrom::Start((idx + 3) & !3))?;
        Ok(())
    }

    pub fn current_pos(&mut self) -> Result<u64> {
        Ok(self.data.stream_position()?)
    }

    pub fn seek_to_object(&mut self, obj: &UnityObject) -> Result<u64> {
        self.seek(SeekFrom::Start(obj.byte_start as u64))
    }

    pub fn seek(&mut self, seek: SeekFrom) -> Result<u64> {
        Ok(self.data.seek(seek)?)
    }

    pub fn set_endianness(&mut self, endianness: Endianness) {
        self.endianness = endianness;
    }

    pub fn read_u8(&mut self) -> Result<u8> {
        Ok(self.data.read_u8()?)
    }

    pub fn read_u16(&mut self) -> Result<u16> {
        match self.endianness {
            Endianness::Big => Ok(self.data.read_u16::<BigEndian>()?),
            Endianness::Little => Ok(self.data.read_u16::<LittleEndian>()?),
        }
    }

    pub fn read_i16(&mut self) -> Result<i16> {
        match self.endianness {
            Endianness::Big => Ok(self.data.read_i16::<BigEndian>()?),
            Endianness::Little => Ok(self.data.read_i16::<LittleEndian>()?),
        }
    }

    pub fn read_i64(&mut self) -> Result<i64> {
        match self.endianness {
            Endianness::Big => Ok(self.data.read_i64::<BigEndian>()?),
            Endianness::Little => Ok(self.data.read_i64::<LittleEndian>()?),
        }
    }

    pub fn read_i32(&mut self) -> Result<i32> {
        match self.endianness {
            Endianness::Big => Ok(self.data.read_i32::<BigEndian>()?),
            Endianness::Little => Ok(self.data.read_i32::<LittleEndian>()?),
        }
    }

    pub fn read_u32(&mut self) -> Result<u32> {
        match self.endianness {
            Endianness::Big => Ok(self.data.read_u32::<BigEndian>()?),
            Endianness::Little => Ok(self.data.read_u32::<LittleEndian>()?),
        }
    }

    pub fn read_u64(&mut self) -> Result<u64> {
        match self.endianness {
            Endianness::Big => Ok(self.data.read_u64::<BigEndian>()?),
            Endianness::Little => Ok(self.data.read_u64::<LittleEndian>()?),
        }
    }

    pub fn read_f32(&mut self) -> Result<f32> {
        match self.endianness {
            Endianness::Big => Ok(self.data.read_f32::<BigEndian>()?),
            Endianness::Little => Ok(self.data.read_f32::<LittleEndian>()?),
        }
    }

    pub fn read_u32_array(&mut self) -> Result<Vec<u32>> {
        let count = self.read_u32()? as usize;
        let mut xs: Vec<u32> = Vec::with_capacity(count);
        for _ in 0..count {
            xs.push(self.read_u32()?);
        }
        Ok(xs)
    }

    pub fn read_char_array(&mut self) -> Result<String> {
        let bytes = self.read_byte_array()?;
        let mut res = String::with_capacity(bytes.len());
        for byte in bytes {
            res.push(byte as char);
        }
        self.align()?;
        Ok(res)
    }

    pub fn read_null_terminated_string(&mut self) -> Result<String> {
        let mut res = String::new();
        loop {
            match self.data.read_u8()? {
                0 => break,
                x => res.push(x as char),
            }
        }
        Ok(res)
    }

    pub fn read_bool(&mut self) -> Result<bool> {
        Ok(self.data.read_u8()? == 1)
    }

    pub fn read_byte_array(&mut self) -> Result<Vec<u8>> {
        let count = self.read_u32()? as usize;
        self.read_bytes(count)
    }

    // possibly just return a &[u8]
    pub fn read_bytes(&mut self, n: usize) -> Result<Vec<u8>> {
        let mut buf = Vec::with_capacity(n);
        unsafe {
            buf.set_len(n);
        }
        self.data.read_exact(&mut buf)?;
        Ok(buf)
    }

    pub fn read_header(&mut self) -> Result<AssetHeader> {
        let mut metadata_size = self.read_u32()?;
        let mut file_size = self.read_u32()? as i64;
        let version = self.read_u32()?;
        if ![17, 18, 19, 20, 21, 22].contains(&version) {
            return Err(AssetReaderError::UnsupportedFileVersion(version));
        }
        let mut data_offset = self.read_u32()? as i64;
        if version < 9 {
            self.seek(std::io::SeekFrom::Start(
                (file_size as u64) - (metadata_size as u64),
            ))?;
        }
        let endianness = match self.data.read_u8()? {
            0 => Endianness::Little,
            _ => Endianness::Big,
        };
        if version >= 9 {
            self.seek(std::io::SeekFrom::Current(3))?; // skip reserved fields
        }

        if version >= 22 {
            metadata_size = self.read_u32()?;
            file_size = self.read_i64()?;
            data_offset = self.read_i64()?;
            self.read_i64()?; // unknown
        }

        Ok(AssetHeader {
            metadata_size: metadata_size as usize,
            file_size: file_size as usize,
            version: version as u8,
            data_offset: data_offset as usize,
            endianness,
        })
    }

    fn read_metadata(&mut self, version: u8) -> Result<AssetMetadata> {
        let unity_version = UnityVersion::try_from(
            (if version >= 7 {
                self.read_null_terminated_string()?
            } else {
                "2.5.0f5".to_string()
            })
            .as_str(),
        )?;
        let target_platform = if version >= 8 { self.read_u32()? } else { 3716 };
        let enable_type_tree = if version >= 13 {
            self.read_bool()?
        } else {
            true
        };
        let type_count = self.read_u32()?;
        let mut types: Vec<SerializedType> = Vec::with_capacity(type_count as usize);
        for _ in 0..type_count {
            types.push(self.read_unity_type(false, enable_type_tree, version)?);
        }
        Ok(AssetMetadata {
            unity_version,
            target_platform,
            enable_type_tree,
            types,
        })
    }

    fn read_unity_type(
        &mut self,
        is_ref_type: bool,
        enable_type_tree: bool,
        version: u8,
    ) -> Result<SerializedType> {
        let class_id = self.read_i32()?;
        let is_stripped_type = if version >= 16 {
            self.read_bool()?
        } else {
            false
        };
        let script_type_index = if version >= 17 { self.read_i16()? } else { -1 };
        let mut script_id = Vec::new();
        if version >= 13
            && ((is_ref_type && script_type_index >= 0) || class_id < 0 || class_id == 114)
        {
            script_id = self.read_bytes(16)?;
        }
        let old_type_hash = if version >= 13 {
            self.read_bytes(16)?
        } else {
            Vec::new()
        };
        let mut type_dependencies = Vec::new();
        let mut class_name = String::new();
        let mut name_space = String::new();
        let mut asm_name = String::new();
        if enable_type_tree {
            if version >= 12 || version == 10 {
                self.read_type_tree_blob(version)?;
            } else {
                self.read_type_tree(version)?;
            }
            if version >= 21 {
                if is_ref_type {
                    class_name = self.read_null_terminated_string()?;
                    name_space = self.read_null_terminated_string()?;
                    asm_name = self.read_null_terminated_string()?;
                } else {
                    type_dependencies = self.read_u32_array()?;
                }
            }
        }

        Ok(SerializedType {
            class_id,
            is_stripped_type,
            script_type_index,
            script_id,
            old_type_hash,
            type_dependencies,
            type_tree: None,
            class_name,
            name_space,
            asm_name,
        })
    }

    fn read_type_tree(&mut self, version: u8) -> Result<Vec<TypeTreeNode>> {
        let mut type_tree = Vec::<TypeTreeNode>::new();
        let mut level_stack = vec![(0, 1)];
        while !level_stack.is_empty() {
            let level_count = level_stack.pop().unwrap();
            if level_count.1 > 1 {
                level_stack.push((level_count.0, level_count.1 - 1));
            }
            type_tree.push(TypeTreeNode {
                level: level_count.0,
                typ: Some(self.read_null_terminated_string()?),
                name: Some(self.read_null_terminated_string()?),
                byte_size: self.read_i32()?,
                variable_count: if version == 2 {
                    Some(self.read_i32()?)
                } else {
                    None
                },
                index: if version != 3 {
                    Some(self.read_i32()?)
                } else {
                    None
                },
                type_flags: self.read_i32()?,
                version: self.read_i32()?,
                meta_flag: if version != 3 {
                    Some(self.read_i32()?)
                } else {
                    None
                },

                type_str_offset: None,
                name_str_offset: None,
                ref_type_hash: None,
            });
            let children_count = self.read_i32()?;
            if children_count > 0 {
                level_stack.push((level_count.0, children_count));
            }
        }
        Ok(type_tree)
    }

    fn read_type_tree_blob(&mut self, version: u8) -> Result<(Vec<TypeTreeNode>, Vec<u8>)> {
        let number_of_nodes = self.read_i32()?;
        let string_buffer_size = self.read_i32()?;
        let mut type_tree = Vec::<TypeTreeNode>::with_capacity(number_of_nodes.try_into().unwrap());
        for _ in 0..number_of_nodes {
            type_tree.push(TypeTreeNode {
                version: self.read_i16()?.into(),
                level: self.read_u8()?,
                type_flags: self.read_u8()?.into(),
                type_str_offset: Some(self.read_u32()?),
                name_str_offset: Some(self.read_u32()?),
                byte_size: self.read_i32()?,
                index: Some(self.read_i32()?),
                meta_flag: Some(self.read_i32()?),
                ref_type_hash: if version >= 19 {
                    Some(self.read_u64()?)
                } else {
                    None
                },
                name: None,
                typ: None,
                variable_count: None,
            });
        }
        Ok((
            type_tree,
            self.read_bytes(string_buffer_size.try_into().unwrap())?,
        ))
    }

    fn read_objects(
        &mut self,
        hdr: &AssetHeader,
        metadata: &AssetMetadata,
    ) -> Result<Vec<UnityObject>> {
        let n_objects = self.read_i32()?;
        let mut objects = Vec::new();
        for _ in 0..n_objects {
            objects.push(self.read_object(hdr, metadata)?)
        }
        Ok(objects)
    }

    fn read_object(&mut self, hdr: &AssetHeader, metadata: &AssetMetadata) -> Result<UnityObject> {
        self.align()?;
        let path_id = self.read_i64()? as i32;
        let mut byte_start = match hdr.version {
            22 => self.read_i64()?,
            _ => self.read_u32()? as i64,
        };
        byte_start += hdr.data_offset as i64;
        let byte_size = self.read_u32()?;
        let type_id = self.read_i32()?;
        let serialized_type = match metadata.types.get(type_id as usize) {
            Some(serialized_type) => serialized_type.clone(),
            None => return Err(AssetReaderError::MissingType(type_id)),
        };
        let class_id = serialized_type.class_id;
        Ok(UnityObject {
            path_id,
            byte_start,
            byte_size,
            type_id,
            serialized_type,
            class_id,
        })
    }

    fn read_script_types(&mut self) -> Result<Vec<ScriptType>> {
        let n_script_types = self.read_i32()?;
        let mut result = Vec::new();
        for _ in 0..n_script_types {
            let local_serialized_file_index = self.read_i32()?;
            self.align()?;
            let local_identifier_in_file = self.read_i64()? as i32;
            result.push(ScriptType {
                local_identifier_in_file,
                local_serialized_file_index,
            });
        }
        Ok(result)
    }

    fn read_externals(&mut self) -> Result<Vec<External>> {
        let n_externals = self.read_i32()?;
        let mut result = Vec::new();
        for _ in 0..n_externals {
            let _empty = self.read_null_terminated_string()?;
            let guid = self.read_bytes(16)?;
            let ext_type = self.read_i32()?;
            let path_name = self.read_null_terminated_string()?;
            result.push(External {
                guid,
                ext_type,
                path_name,
            })
        }
        Ok(result)
    }

    fn read_ref_types(
        &mut self,
        metadata: &AssetMetadata,
        version: u8,
    ) -> Result<Vec<SerializedType>> {
        let n_ref_types = self.read_i32()?;
        let mut result = Vec::new();
        for _ in 0..n_ref_types {
            result.push(self.read_unity_type(true, metadata.enable_type_tree, version)?);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_test_asset() -> AssetReader {
        // from Subnautica
        let data = std::fs::read("test_data/unity_assets/v20/sharedassets0.assets").unwrap();
        AssetReader::new(data)
    }

    #[test]
    fn test_header() {
        let mut reader = read_test_asset();
        let hdr = reader.read_header().unwrap();
        assert_eq!(hdr.metadata_size, 2493);
        assert_eq!(hdr.file_size, 17649856);
        assert_eq!(hdr.version, 20);
        assert_eq!(hdr.data_offset, 4096);
    }

    #[test]
    fn test_metadata() {
        let mut reader = read_test_asset();
        let hdr = reader.read_header().unwrap();
        reader.set_endianness(hdr.endianness);
        let metadata = reader.read_metadata(hdr.version).unwrap();
        assert_eq!(
            metadata.unity_version,
            UnityVersion::try_from("2019.2.17f1").unwrap()
        );
    }

    #[test]
    fn test_objects() {
        use std::collections::HashMap;

        let mut reader = read_test_asset();
        let hdr = reader.read_header().unwrap();
        reader.set_endianness(hdr.endianness);
        let metadata = reader.read_metadata(hdr.version).unwrap();
        let objects = reader.read_objects(&hdr, &metadata).unwrap();
        assert_eq!(objects.len(), 56);

        // count how many objects there are per type
        let mut stats: HashMap<i32, usize> = HashMap::new();
        for obj in objects {
            *stats.entry(obj.class_id).or_insert(0) += 1;
        }
        assert_eq!(stats.get(&150), Some(&1)); // PreloadData
        assert_eq!(stats.get(&21), Some(&10)); // Material
        assert_eq!(stats.get(&28), Some(&12)); // Texture2D
        assert_eq!(stats.get(&128), Some(&9)); // Font
        assert_eq!(stats.get(&213), Some(&1)); // Sprite
        assert_eq!(stats.get(&1), Some(&1)); // GameObject
        assert_eq!(stats.get(&4), Some(&1)); // Transform
        assert_eq!(stats.get(&114), Some(&21)); // MonoBehaviour
    }

    #[test]
    fn test_script_types() {
        let mut reader = read_test_asset();
        let hdr = reader.read_header().unwrap();
        reader.set_endianness(hdr.endianness);
        let metadata = reader.read_metadata(hdr.version).unwrap();
        let _ = reader.read_objects(&hdr, &metadata).unwrap();
        let _script_types = reader.read_script_types().unwrap();
    }

    #[test]
    fn test_externals() {
        let mut reader = read_test_asset();
        let hdr = reader.read_header().unwrap();
        reader.set_endianness(hdr.endianness);
        let metadata = reader.read_metadata(hdr.version).unwrap();
        let _ = reader.read_objects(&hdr, &metadata).unwrap();
        let _script_types = reader.read_script_types().unwrap();
        let externals = reader.read_externals().unwrap();
        assert_eq!(externals.len(), 2);
        assert_eq!(&externals[0].path_name, "globalgamemanagers.assets");
        assert_eq!(&externals[1].path_name, "library/unity default resources");
    }

    #[test]
    fn test_ref_types() {
        let mut reader = read_test_asset();
        let hdr = reader.read_header().unwrap();
        reader.set_endianness(hdr.endianness);
        let metadata = reader.read_metadata(hdr.version).unwrap();
        let _ = reader.read_objects(&hdr, &metadata).unwrap();
        let _ = reader.read_script_types().unwrap();
        let _ = reader.read_externals().unwrap();
        let ref_types = reader.read_ref_types(&metadata, hdr.version).unwrap();
        assert_eq!(ref_types.len(), 0);
    }

    #[test]
    fn test_all_together() {
        let mut reader = read_test_asset();
        let _asset = reader.read_asset_info().unwrap();
    }

    #[test]
    fn test_v22() {
        let data = std::fs::read("test_data/unity_assets/v22/sharedassets0.assets").unwrap();
        let mut reader = AssetReader::new(data);
        let _asset = reader.read_asset_info().unwrap();
    }

    #[test]
    fn test_cactus() {
        use crate::unity::mesh::Mesh;
        let data = std::fs::read("../data/hike/level2").unwrap();
        let mut reader = AssetReader::new(data);
        let asset = reader.read_asset_info().unwrap();
        dbg!(&asset.externals[1]);
        let data = std::fs::read("../data/hike/sharedassets2.assets").unwrap();
        let mut reader = AssetReader::new(data);
        let asset = reader.read_asset_info().unwrap();
        let m = asset.objects.iter().find(|obj| obj.path_id == 612).unwrap();
        reader.seek_to_object(&m).unwrap();
        let _x = Mesh::deserialize(&mut reader, &asset);
    }
}
