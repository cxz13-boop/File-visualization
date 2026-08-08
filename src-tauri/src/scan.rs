use std::{
    collections::{HashMap, VecDeque},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

const BATCH_SIZE: usize = 200;
const PROGRESS_EVERY: usize = 500;
const CACHE_MAGIC: &[u8; 8] = b"FVSCACHE";
const CACHE_VERSION: u8 = 1;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStarted {
    pub path: String,
    pub root_id: String,
    pub generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodesBatch {
    pub nodes: Vec<NodeDto>,
    pub batch_index: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scanned: usize,
    pub current_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalItem {
    pub id: String,
    pub total_size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanComplete {
    pub root_id: String,
    pub total_size: u64,
    pub node_count: usize,
    pub duration_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub total_size: u64,
    pub children_ids: Vec<String>,
    pub depth: usize,
    pub status: String,
    pub modified_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    pub node: NodeDto,
    pub parent: NodeDto,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub node: NodeDto,
    pub ancestor_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    root_path: String,
    root_id: String,
    node_count: usize,
    created_at: u64,
    nodes: Vec<NodeDto>,
}

struct Node {
    id: String,
    parent_id: Option<String>,
    name: String,
    path: String,
    kind: String,
    size: u64,
    total_size: u64,
    children_ids: Vec<String>,
    depth: usize,
    status: String,
    modified_at: Option<u64>,
}

impl Node {
    fn to_dto(&self) -> NodeDto {
        NodeDto {
            id: self.id.clone(),
            parent_id: self.parent_id.clone(),
            name: self.name.clone(),
            path: self.path.clone(),
            kind: self.kind.clone(),
            size: self.size,
            total_size: self.total_size,
            children_ids: self.children_ids.clone(),
            depth: self.depth,
            status: self.status.clone(),
            modified_at: self.modified_at,
        }
    }
}

struct ScanCollection {
    nodes: HashMap<String, Node>,
    order: Vec<String>,
    root_id: String,
}

pub struct ScanGraph {
    nodes: HashMap<String, Node>,
}

impl ScanGraph {
    pub fn children(&self, node_id: &str) -> Result<Vec<NodeDto>, String> {
        let parent = self
            .nodes
            .get(node_id)
            .ok_or_else(|| format!("节点不存在: {node_id}"))?;
        if parent.kind != "dir" {
            return Ok(Vec::new());
        }
        let mut children = parent
            .children_ids
            .iter()
            .filter_map(|id| self.nodes.get(id))
            .map(|node| node.to_dto())
            .collect::<Vec<_>>();
        children.sort_by(|left, right| {
            right
                .total_size
                .cmp(&left.total_size)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(children)
    }

    pub fn create_child(
        &mut self,
        parent_id: &str,
        name: &str,
        kind: &str,
        path: &str,
        size: u64,
        modified_at: Option<u64>,
    ) -> Result<NodeDto, String> {
        let depth = {
            let parent = self
                .nodes
                .get(parent_id)
                .ok_or_else(|| "父节点不存在".to_string())?;
            if parent.kind != "dir" {
                return Err("父节点不是文件夹".to_string());
            }
            parent.depth + 1
        };
        let node = Node {
            id: path.to_string(),
            parent_id: Some(parent_id.to_string()),
            name: name.to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            size,
            total_size: size,
            children_ids: Vec::new(),
            depth,
            status: "loaded".to_string(),
            modified_at,
        };
        let dto = node.to_dto();
        if let Some(parent) = self.nodes.get_mut(parent_id) {
            parent.children_ids.push(dto.id.clone());
        }
        self.nodes.insert(dto.id.clone(), node);
        Ok(dto)
    }

    pub fn parent_dto(&self, parent_id: &str) -> Result<NodeDto, String> {
        self.nodes
            .get(parent_id)
            .map(|node| node.to_dto())
            .ok_or_else(|| "父节点不存在".to_string())
    }

    pub fn from_dtos(dtos: Vec<NodeDto>) -> Self {
        let mut nodes = HashMap::new();
        for dto in dtos {
            nodes.insert(
                dto.id.clone(),
                Node {
                    id: dto.id,
                    parent_id: dto.parent_id,
                    name: dto.name,
                    path: dto.path,
                    kind: dto.kind,
                    size: dto.size,
                    total_size: dto.total_size,
                    children_ids: dto.children_ids,
                    depth: dto.depth,
                    status: dto.status,
                    modified_at: dto.modified_at,
                },
            );
        }
        ScanGraph { nodes }
    }

    pub fn all_dtos(&self) -> Vec<NodeDto> {
        self.nodes.values().map(|node| node.to_dto()).collect()
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let lower = query.trim().to_lowercase();
        if lower.is_empty() {
            return Vec::new();
        }
        let mut hits = self
            .nodes
            .values()
            .filter(|node| node.name.to_lowercase().contains(&lower))
            .map(|node| SearchHit {
                node: node.to_dto(),
                ancestor_ids: self.ancestor_ids(&node.id),
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| {
            left.node
                .depth
                .cmp(&right.node.depth)
                .then_with(|| right.node.total_size.cmp(&left.node.total_size))
        });
        hits.truncate(limit);
        hits
    }

    fn ancestor_ids(&self, node_id: &str) -> Vec<String> {
        let mut ids = Vec::new();
        let mut current = self
            .nodes
            .get(node_id)
            .and_then(|node| node.parent_id.clone());
        while let Some(parent_id) = current {
            ids.push(parent_id.clone());
            current = self
                .nodes
                .get(&parent_id)
                .and_then(|node| node.parent_id.clone());
        }
        ids.reverse();
        ids
    }
}

pub fn scan_directory(
    app: &AppHandle,
    root: &Path,
    generation: u64,
    refresh: bool,
    default_depth: usize,
    excludes: &[String],
) -> Result<(), String> {
    let started = Instant::now();
    let root_id = root.to_string_lossy().into_owned();
    let root_string = root.to_string_lossy().into_owned();

    let _ = app.emit(
        "scan://started",
        ScanStarted {
            path: root_string.clone(),
            root_id: root_id.clone(),
            generation,
        },
    );

    if !refresh {
        if let Some(graph) = load_cache(app, root, &root_id) {
            let initial_nodes = initial_dtos(&graph.nodes, default_depth);
            let root_total = graph
                .nodes
                .get(&root_id)
                .map(|node| node.total_size)
                .unwrap_or(0);
            let node_count = graph.nodes.len();
            *app.state::<AppState>()
                .current_scan
                .lock()
                .expect("current scan lock poisoned") = Some(graph);
            for (index, chunk) in initial_nodes.chunks(BATCH_SIZE).enumerate() {
                let _ = app.emit(
                    "scan://nodes",
                    NodesBatch {
                        nodes: chunk.to_vec(),
                        batch_index: index,
                    },
                );
            }
            let _ = app.emit(
                "scan://progress",
                ScanProgress {
                    scanned: node_count,
                    current_path: root_string.clone(),
                },
            );
            let _ = app.emit(
                "scan://complete",
                ScanComplete {
                    root_id,
                    total_size: root_total,
                    node_count,
                    duration_ms: 0,
                },
            );
            return Ok(());
        }
    }

    let mut scanned = 0usize;
    let mut on_node = |_node: &NodeDto, current_path: &str| {
        scanned += 1;
        if scanned % PROGRESS_EVERY == 0 {
            let _ = app.emit(
                "scan://progress",
                ScanProgress {
                    scanned,
                    current_path: current_path.to_string(),
                },
            );
        }
    };

    let current_generation = &app.state::<AppState>().scan_generation;
    let collection = match collect_scan(
        root,
        generation,
        current_generation,
        excludes,
        &mut on_node,
    ) {
        Ok(collection) => collection,
        Err(message) if message == "cancelled" => return Ok(()),
        Err(message) => return Err(message),
    };
    drop(on_node);

    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            scanned,
            current_path: root_string,
        },
    );

    let mut nodes = collection.nodes;
    let order = collection.order;
    let _ = compute_totals(&mut nodes, &order);
    sort_children_by_size(&mut nodes);

    let initial_nodes = initial_dtos(&nodes, default_depth);

    let root_total = nodes
        .get(&root_id)
        .map(|node| node.total_size)
        .unwrap_or(0);
    let node_count = nodes.len();

    let cache_dtos: Vec<NodeDto> = nodes.values().map(|node| node.to_dto()).collect();
    save_cache(app, root, &root_id, &cache_dtos);

    *app.state::<AppState>()
        .current_scan
        .lock()
        .expect("current scan lock poisoned") = Some(ScanGraph { nodes });

    for (index, chunk) in initial_nodes.chunks(BATCH_SIZE).enumerate() {
        let _ = app.emit(
            "scan://nodes",
            NodesBatch {
                nodes: chunk.to_vec(),
                batch_index: index,
            },
        );
    }

    let _ = app.emit(
        "scan://complete",
        ScanComplete {
            root_id: collection.root_id,
            total_size: root_total,
            node_count,
            duration_ms: started.elapsed().as_millis() as u64,
        },
    );

    Ok(())
}

pub fn generate_stress_scan(
    app: &AppHandle,
    generation: u64,
    default_depth: usize,
) -> Result<(), String> {
    let started = Instant::now();
    let root_id = "stress://root".to_string();
    let root_path = "stress://100000".to_string();

    let _ = app.emit(
        "scan://started",
        ScanStarted {
            path: root_path.clone(),
            root_id: root_id.clone(),
            generation,
        },
    );

    let mut collection = build_stress_collection(100_000);
    let order = collection.order.clone();
    let _ = compute_totals(&mut collection.nodes, &order);
    sort_children_by_size(&mut collection.nodes);

    let initial_nodes = initial_dtos(&collection.nodes, default_depth);
    let root_total = collection
        .nodes
        .get(&root_id)
        .map(|node| node.total_size)
        .unwrap_or(0);
    let node_count = collection.nodes.len();

    *app.state::<AppState>()
        .current_scan
        .lock()
        .expect("current scan lock poisoned") = Some(ScanGraph {
        nodes: collection.nodes,
    });

    for (index, chunk) in initial_nodes.chunks(BATCH_SIZE).enumerate() {
        let _ = app.emit(
            "scan://nodes",
            NodesBatch {
                nodes: chunk.to_vec(),
                batch_index: index,
            },
        );
    }
    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            scanned: node_count,
            current_path: root_path,
        },
    );
    let _ = app.emit(
        "scan://complete",
        ScanComplete {
            root_id,
            total_size: root_total,
            node_count,
            duration_ms: started.elapsed().as_millis() as u64,
        },
    );

    Ok(())
}

fn build_stress_collection(target: usize) -> ScanCollection {
    let root_id = "stress://root".to_string();
    let root_path = "stress://100000".to_string();
    let mut nodes = HashMap::with_capacity(target);
    let mut order = Vec::with_capacity(target);

    nodes.insert(
        root_id.clone(),
        Node {
            id: root_id.clone(),
            parent_id: None,
            name: "示例文件展示".to_string(),
            path: root_path.clone(),
            kind: "dir".to_string(),
            size: 0,
            total_size: 0,
            children_ids: Vec::new(),
            depth: 0,
            status: "loaded".to_string(),
            modified_at: Some(1_700_000_000_000),
        },
    );
    order.push(root_id.clone());

    let mut queue = VecDeque::from([root_id.clone()]);
    let mut next_index = 1usize;
    while next_index < target {
        let Some(parent_id) = queue.pop_front() else {
            break;
        };
        let parent_depth = nodes.get(&parent_id).map(|node| node.depth).unwrap_or(0);
        let branch = (target - next_index).min(10);
        for offset in 0..branch {
            let index = next_index + offset;
            let id = format!("stress://node/{index:06}");
            let name = format!("item_{index:06}");
            let kind = if index % 5 == 0 { "dir" } else { "file" };
            let size = if kind == "dir" {
                0
            } else {
                ((index as u64 * 2_654_435_761) % 2_000_000) + 1024
            };
            let path = format!("{root_path}/item_{index:06}");
            nodes.insert(
                id.clone(),
                Node {
                    id: id.clone(),
                    parent_id: Some(parent_id.clone()),
                    name,
                    path,
                    kind: kind.to_string(),
                    size,
                    total_size: 0,
                    children_ids: Vec::new(),
                    depth: parent_depth + 1,
                    status: "loaded".to_string(),
                    modified_at: Some(1_700_000_000_000 + index as u64),
                },
            );
            order.push(id.clone());
            if kind == "dir" {
                queue.push_back(id.clone());
            }
            if let Some(parent) = nodes.get_mut(&parent_id) {
                parent.children_ids.push(id);
            }
        }
        next_index += branch;
    }

    ScanCollection {
        nodes,
        order,
        root_id,
    }
}

fn is_excluded(name: &str, excludes: &[String]) -> bool {
    let lower = name.to_lowercase();
    excludes
        .iter()
        .any(|rule| !rule.is_empty() && lower == rule.to_lowercase())
}

fn collect_scan<F>(
    root: &Path,
    generation: u64,
    current_generation: &AtomicU64,
    excludes: &[String],
    on_node: &mut F,
) -> Result<ScanCollection, String>
where
    F: FnMut(&NodeDto, &str),
{
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("根目录")
        .to_string();
    let root_id = root.to_string_lossy().into_owned();

    let mut nodes: HashMap<String, Node> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut pending: Vec<(PathBuf, Option<String>, String, usize)> =
        vec![(root.to_path_buf(), None, root_name, 0)];

    while let Some((path, parent_id, name, depth)) = pending.pop() {
        if current_generation.load(Ordering::SeqCst) != generation {
            return Err("cancelled".to_string());
        }

        let id = path.to_string_lossy().into_owned();
        let meta = std::fs::symlink_metadata(&path);
        let mut kind = "file";
        let mut status = "loaded";
        let mut size = 0u64;
        let mut modified_at = None;
        let mut child_tasks: Vec<(PathBuf, String, usize)> = Vec::new();
        let mut children_ids: Vec<String> = Vec::new();

        match meta {
            Ok(metadata) => {
                modified_at = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64);
                if metadata.is_dir() {
                    kind = "dir";
                    if is_excluded(&name, excludes) {
                        status = "filtered";
                    } else {
                        match std::fs::read_dir(&path) {
                            Ok(entries) => {
                                for entry in entries.flatten() {
                                    let child_path = entry.path();
                                    let child_name =
                                        entry.file_name().to_string_lossy().into_owned();
                                    child_tasks.push((child_path, child_name, depth + 1));
                                }
                            }
                            Err(_) => {
                                status = "error";
                            }
                        }
                        child_tasks.sort_by(|left, right| {
                            left.1
                                .to_lowercase()
                                .cmp(&right.1.to_lowercase())
                        });
                        children_ids = child_tasks
                            .iter()
                            .map(|(child_path, _, _)| child_path.to_string_lossy().into_owned())
                            .collect();
                    }
                } else {
                    size = metadata.len();
                }
            }
            Err(_) => {
                status = "error";
            }
        }

        nodes.insert(
            id.clone(),
            Node {
                id: id.clone(),
                parent_id,
                name,
                path: path.to_string_lossy().into_owned(),
                kind: kind.to_string(),
                size,
                total_size: 0,
                children_ids,
                depth,
                status: status.to_string(),
                modified_at,
            },
        );
        order.push(id.clone());
        let current_path = path.to_string_lossy();
        on_node(&nodes[&id].to_dto(), &current_path);

        for (child_path, child_name, child_depth) in child_tasks.into_iter().rev() {
            pending.push((child_path, Some(id.clone()), child_name, child_depth));
        }
    }

    Ok(ScanCollection {
        nodes,
        order,
        root_id,
    })
}

fn compute_totals(
    nodes: &mut HashMap<String, Node>,
    order: &[String],
) -> Vec<TotalItem> {
    let mut totals = Vec::with_capacity(order.len());
    for id in order.iter().rev() {
        let is_summarizable_dir = nodes
            .get(id)
            .map(|node| node.kind == "dir" && node.status != "error")
            .unwrap_or(false);
        let total_size = if is_summarizable_dir {
            let child_ids =
                std::mem::take(&mut nodes.get_mut(id).expect("scanned node exists").children_ids);
            let mut sum = 0u64;
            for child_id in &child_ids {
                sum = sum.saturating_add(
                    nodes
                        .get(child_id)
                        .map(|child| child.total_size)
                        .unwrap_or(0),
                );
            }
            nodes
                .get_mut(id)
                .expect("scanned node exists")
                .children_ids = child_ids;
            sum
        } else {
            nodes.get(id).expect("scanned node exists").size
        };
        nodes.get_mut(id).expect("scanned node exists").total_size = total_size;
        totals.push(TotalItem {
            id: id.clone(),
            total_size,
        });
    }
    totals
}

fn sort_children_by_size(nodes: &mut HashMap<String, Node>) {
    let pairs: Vec<(String, Vec<String>)> = nodes
        .iter()
        .map(|(id, node)| (id.clone(), node.children_ids.clone()))
        .collect();
    for (parent_id, mut children) in pairs {
        children.sort_by(|left, right| {
            let left_total = nodes.get(left).map(|node| node.total_size).unwrap_or(0);
            let right_total = nodes.get(right).map(|node| node.total_size).unwrap_or(0);
            right_total
                .cmp(&left_total)
                .then_with(|| left.to_lowercase().cmp(&right.to_lowercase()))
        });
        if let Some(node) = nodes.get_mut(&parent_id) {
            node.children_ids = children;
        }
    }
}

fn initial_dtos(nodes: &HashMap<String, Node>, max_depth: usize) -> Vec<NodeDto> {
    nodes
        .values()
        .filter(|node| node.depth <= max_depth)
        .map(|node| node.to_dto())
        .collect()
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("cache");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn cache_key(path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn write_cache_str(bytes: &mut Vec<u8>, value: &str) {
    let utf8 = value.as_bytes();
    bytes.extend_from_slice(&(utf8.len() as u32).to_le_bytes());
    bytes.extend_from_slice(utf8);
}

fn write_cache_opt_str(bytes: &mut Vec<u8>, value: Option<&str>) {
    match value {
        Some(text) => {
            bytes.push(1);
            write_cache_str(bytes, text);
        }
        None => bytes.push(0),
    }
}

fn encode_cache(cache: &CacheFile) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(64 + cache.nodes.len() * 96);
    bytes.extend_from_slice(CACHE_MAGIC);
    bytes.push(CACHE_VERSION);
    write_cache_str(&mut bytes, &cache.root_path);
    write_cache_str(&mut bytes, &cache.root_id);
    bytes.extend_from_slice(&(cache.node_count as u64).to_le_bytes());
    bytes.extend_from_slice(&cache.created_at.to_le_bytes());
    bytes.extend_from_slice(&(cache.nodes.len() as u32).to_le_bytes());
    for node in &cache.nodes {
        write_cache_str(&mut bytes, &node.id);
        write_cache_opt_str(&mut bytes, node.parent_id.as_deref());
        write_cache_str(&mut bytes, &node.name);
        write_cache_str(&mut bytes, &node.path);
        write_cache_str(&mut bytes, &node.kind);
        bytes.extend_from_slice(&node.size.to_le_bytes());
        bytes.extend_from_slice(&node.total_size.to_le_bytes());
        bytes.extend_from_slice(&(node.children_ids.len() as u32).to_le_bytes());
        for child in &node.children_ids {
            write_cache_str(&mut bytes, child);
        }
        bytes.extend_from_slice(&(node.depth as u32).to_le_bytes());
        write_cache_str(&mut bytes, &node.status);
        match node.modified_at {
            Some(value) => {
                bytes.push(1);
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            None => bytes.push(0),
        }
    }
    bytes
}

struct CacheReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> CacheReader<'a> {
    fn read_u8(&mut self) -> Option<u8> {
        let value = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(value)
    }

    fn read_u32(&mut self) -> Option<u32> {
        let raw = self.data.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_le_bytes(raw.try_into().ok()?))
    }

    fn read_u64(&mut self) -> Option<u64> {
        let raw = self.data.get(self.pos..self.pos + 8)?;
        self.pos += 8;
        Some(u64::from_le_bytes(raw.try_into().ok()?))
    }

    fn read_str(&mut self) -> Option<String> {
        let length = self.read_u32()? as usize;
        let raw = self.data.get(self.pos..self.pos + length)?;
        self.pos += length;
        String::from_utf8(raw.to_vec()).ok()
    }

    fn read_opt_str(&mut self) -> Option<Option<String>> {
        match self.read_u8()? {
            0 => Some(None),
            1 => Some(Some(self.read_str()?)),
            _ => None,
        }
    }
}

fn decode_cache(data: &[u8]) -> Option<CacheFile> {
    if data.len() < CACHE_MAGIC.len() + 1
        || &data[..CACHE_MAGIC.len()] != CACHE_MAGIC
        || data[CACHE_MAGIC.len()] != CACHE_VERSION
    {
        return None;
    }
    let mut reader = CacheReader {
        data,
        pos: CACHE_MAGIC.len() + 1,
    };
    let root_path = reader.read_str()?;
    let root_id = reader.read_str()?;
    let node_count = reader.read_u64()? as usize;
    let created_at = reader.read_u64()?;
    let count = reader.read_u32()? as usize;
    if count > 5_000_000 {
        return None;
    }
    let mut nodes = Vec::with_capacity(count);
    for _ in 0..count {
        let id = reader.read_str()?;
        let parent_id = reader.read_opt_str()?;
        let name = reader.read_str()?;
        let path = reader.read_str()?;
        let kind = reader.read_str()?;
        let size = reader.read_u64()?;
        let total_size = reader.read_u64()?;
        let children_len = reader.read_u32()? as usize;
        if children_len > 1_000_000 {
            return None;
        }
        let mut children_ids = Vec::with_capacity(children_len);
        for _ in 0..children_len {
            children_ids.push(reader.read_str()?);
        }
        let depth = reader.read_u32()? as usize;
        let status = reader.read_str()?;
        let modified_at = match reader.read_u8()? {
            0 => None,
            1 => Some(reader.read_u64()?),
            _ => return None,
        };
        nodes.push(NodeDto {
            id,
            parent_id,
            name,
            path,
            kind,
            size,
            total_size,
            children_ids,
            depth,
            status,
            modified_at,
        });
    }
    Some(CacheFile {
        root_path,
        root_id,
        node_count,
        created_at,
        nodes,
    })
}

fn load_cache(app: &AppHandle, root: &Path, root_id: &str) -> Option<ScanGraph> {
    let dir = cache_dir(app).ok()?;
    let key = cache_key(&root.to_string_lossy());
    for (extension, binary) in [("fvc", true), ("json", false)] {
        let file = dir.join(format!("{key}.{extension}"));
        let Ok(data) = std::fs::read(file) else {
            continue;
        };
        let cache = if binary {
            decode_cache(&data)
                .or_else(|| serde_json::from_slice::<CacheFile>(&data).ok())
        } else {
            serde_json::from_slice::<CacheFile>(&data).ok()
        };
        if let Some(cache) = cache {
            if cache.root_id == root_id {
                return Some(ScanGraph::from_dtos(cache.nodes));
            }
        }
    }
    None
}

fn save_cache(
    app: &AppHandle,
    root: &Path,
    root_id: &str,
    nodes: &[NodeDto],
) {
    let Ok(dir) = cache_dir(app) else {
        return;
    };
    let key = cache_key(&root.to_string_lossy());
    let file = dir.join(format!("{key}.fvc"));
    let cache = CacheFile {
        root_path: root.to_string_lossy().into_owned(),
        root_id: root_id.to_string(),
        node_count: nodes.len(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
        nodes: nodes.to_vec(),
    };
    let data = encode_cache(&cache);
    if std::fs::write(&file, data).is_ok() {
        let _ = std::fs::remove_file(dir.join(format!("{key}.json")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: &'static str, size: u64, children_ids: Vec<String>) -> Node {
        Node {
            id: id.to_string(),
            parent_id: None,
            name: id.to_string(),
            path: id.to_string(),
            kind: kind.to_string(),
            size,
            total_size: 0,
            children_ids,
            depth: 0,
            status: "loaded".to_string(),
            modified_at: None,
        }
    }

    #[test]
    fn totals_aggregate_bottom_up() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "root".to_string(),
            node("root", "dir", 0, vec!["a".to_string(), "b".to_string()]),
        );
        nodes.insert("a".to_string(), node("a", "file", 10, vec![]));
        nodes.insert(
            "b".to_string(),
            node("b", "dir", 0, vec!["c".to_string()]),
        );
        nodes.insert("c".to_string(), node("c", "file", 5, vec![]));
        let order = vec![
            "root".to_string(),
            "b".to_string(),
            "c".to_string(),
            "a".to_string(),
        ];

        let totals = compute_totals(&mut nodes, &order);

        assert_eq!(nodes["a"].total_size, 10);
        assert_eq!(nodes["c"].total_size, 5);
        assert_eq!(nodes["b"].total_size, 5);
        assert_eq!(nodes["root"].total_size, 15);
        assert_eq!(totals.len(), 4);
    }

    #[test]
    fn empty_dir_has_zero_total() {
        let mut nodes = HashMap::new();
        nodes.insert("root".to_string(), node("root", "dir", 0, vec![]));
        let order = vec!["root".to_string()];

        let totals = compute_totals(&mut nodes, &order);

        assert_eq!(nodes["root"].total_size, 0);
        assert_eq!(totals[0].total_size, 0);
    }

    #[test]
    fn collect_scan_builds_tree_with_totals() {
        let temp_root = std::env::temp_dir().join(format!(
            "file-visualizer-scan-test-{}",
            std::process::id()
        ));
        let sub = temp_root.join("sub");
        std::fs::create_dir_all(&sub).expect("create temp dirs");
        std::fs::write(temp_root.join("a.txt"), [0u8; 10]).expect("write a");
        std::fs::write(sub.join("b.txt"), [0u8; 5]).expect("write b");

        let generation = AtomicU64::new(1);
        let mut dtos: Vec<NodeDto> = Vec::new();
        let mut collection = collect_scan(
            &temp_root,
            1,
            &generation,
            &[],
            &mut |node, _| {
                dtos.push(node.clone());
            },
        )
        .expect("scan should succeed");

        let totals = compute_totals(&mut collection.nodes, &collection.order);

        assert_eq!(dtos.len(), 4);
        assert_eq!(totals.len(), 4);
        assert_eq!(collection.nodes[&collection.root_id].total_size, 15);

        let _ = std::fs::remove_file(temp_root.join("a.txt"));
        let _ = std::fs::remove_file(sub.join("b.txt"));
        let _ = std::fs::remove_dir(&sub);
        let _ = std::fs::remove_dir(&temp_root);
    }

    #[test]
    fn graph_children_are_sorted_by_total_size_desc() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "root".to_string(),
            node(
                "root",
                "dir",
                0,
                vec!["small".to_string(), "big".to_string()],
            ),
        );
        nodes.insert("big".to_string(), node("big", "file", 100, vec![]));
        nodes.insert("small".to_string(), node("small", "file", 1, vec![]));
        let order = vec![
            "root".to_string(),
            "big".to_string(),
            "small".to_string(),
        ];
        let _ = compute_totals(&mut nodes, &order);
        sort_children_by_size(&mut nodes);

        let graph = ScanGraph { nodes };
        let children = graph.children("root").expect("children should exist");

        assert_eq!(children.len(), 2);
        assert_eq!(children[0].id, "big");
        assert_eq!(children[1].id, "small");
    }

    #[test]
    fn initial_dtos_respect_depth_limit() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "root".to_string(),
            node("root", "dir", 0, vec!["child".to_string()]),
        );
        nodes.insert(
            "child".to_string(),
            node("child", "dir", 0, vec!["deep".to_string()]),
        );
        nodes.insert("deep".to_string(), node("deep", "file", 1, vec![]));
        nodes.get_mut("child").expect("child exists").depth = 1;
        nodes.get_mut("deep").expect("deep exists").depth = 2;

        let dtos = initial_dtos(&nodes, 1);

        assert_eq!(dtos.len(), 2);
        assert!(!dtos.iter().any(|node| node.id == "deep"));
    }

    #[test]
    fn excluded_dir_is_filtered_and_not_descended() {
        let temp_root = std::env::temp_dir().join(format!(
            "file-visualizer-exclude-test-{}",
            std::process::id()
        ));
        let excluded = temp_root.join("node_modules");
        std::fs::create_dir_all(excluded.join("deep")).expect("create temp dirs");
        std::fs::write(excluded.join("deep").join("a.txt"), [0u8; 1])
            .expect("write file");
        let generation = AtomicU64::new(1);
        let excludes = vec!["node_modules".to_string()];

        let collection = collect_scan(
            &temp_root,
            1,
            &generation,
            &excludes,
            &mut |_, _| {},
        )
        .expect("scan should succeed");

        assert_eq!(collection.nodes.len(), 2);
        let excluded_id = excluded.to_string_lossy().into_owned();
        let excluded_node = collection.nodes.get(&excluded_id).expect("node exists");
        assert_eq!(excluded_node.status, "filtered");
        assert!(excluded_node.children_ids.is_empty());

        let _ = std::fs::remove_file(excluded.join("deep").join("a.txt"));
        let _ = std::fs::remove_dir(excluded.join("deep"));
        let _ = std::fs::remove_dir(&excluded);
        let _ = std::fs::remove_dir(&temp_root);
    }

    #[test]
    fn deep_tree_does_not_overflow() {
        let temp_root = std::env::temp_dir().join(format!(
            "file-visualizer-deep-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_root).expect("create temp root");
        let mut current = temp_root.clone();
        for index in 0..200 {
            current = current.join(format!("d{index:03}"));
            std::fs::create_dir(&current).expect("create dir");
        }
        std::fs::write(current.join("leaf.txt"), [0u8; 1]).expect("write file");
        let generation = AtomicU64::new(1);

        let collection = collect_scan(
            &temp_root,
            1,
            &generation,
            &[],
            &mut |_, _| {},
        )
        .expect("scan should succeed");

        assert_eq!(collection.nodes.len(), 202);
        let leaf_id = current.to_string_lossy().into_owned();
        assert_eq!(collection.nodes[&leaf_id].depth, 200);

        let _ = std::fs::remove_file(current.join("leaf.txt"));
        for _ in 0..200 {
            let _ = std::fs::remove_dir(&current);
            current = current.parent().expect("parent exists").to_path_buf();
        }
    }

    #[test]
    fn binary_cache_round_trip() {
        let nodes = vec![
            NodeDto {
                id: "root".to_string(),
                parent_id: None,
                name: "root".to_string(),
                path: "C:\\root".to_string(),
                kind: "dir".to_string(),
                size: 0,
                total_size: 123,
                children_ids: vec!["child".to_string()],
                depth: 0,
                status: "loaded".to_string(),
                modified_at: Some(42),
            },
            NodeDto {
                id: "child".to_string(),
                parent_id: Some("root".to_string()),
                name: "child.txt".to_string(),
                path: "C:\\root\\child.txt".to_string(),
                kind: "file".to_string(),
                size: 123,
                total_size: 123,
                children_ids: Vec::new(),
                depth: 1,
                status: "loaded".to_string(),
                modified_at: None,
            },
        ];
        let cache = CacheFile {
            root_path: "C:\\root".to_string(),
            root_id: "root".to_string(),
            node_count: nodes.len(),
            created_at: 1_700_000_000,
            nodes,
        };

        let encoded = encode_cache(&cache);
        let decoded = decode_cache(&encoded).expect("binary cache should decode");

        assert_eq!(decoded.root_id, "root");
        assert_eq!(decoded.node_count, 2);
        assert_eq!(decoded.nodes.len(), 2);
        assert_eq!(decoded.nodes[0].children_ids, vec!["child".to_string()]);
        assert_eq!(decoded.nodes[1].parent_id.as_deref(), Some("root"));
        assert_eq!(decoded.nodes[1].modified_at, None);
    }

    #[test]
    fn stress_graph_100k_aggregates() {
        let collection = build_stress_collection(100_000);
        assert_eq!(collection.nodes.len(), 100_000);

        let order = collection.order.clone();
        let mut nodes = collection.nodes;
        let _ = compute_totals(&mut nodes, &order);

        let root_total = nodes
            .get(&collection.root_id)
            .map(|node| node.total_size)
            .unwrap_or(0);
        assert!(root_total > 0);
        let dir_count = nodes.values().filter(|node| node.kind == "dir").count();
        let file_count = nodes.values().filter(|node| node.kind == "file").count();
        assert!(dir_count > 10_000);
        assert_eq!(dir_count + file_count, 100_000);
    }

    #[test]
    fn search_returns_ancestors_for_deep_node() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "root".to_string(),
            node("root", "dir", 0, vec!["child".to_string()]),
        );
        nodes.insert(
            "child".to_string(),
            node("child", "dir", 0, vec!["Deep.txt".to_string()]),
        );
        nodes.insert(
            "Deep.txt".to_string(),
            node("Deep.txt", "file", 10, Vec::new()),
        );
        nodes.get_mut("child").expect("child exists").parent_id = Some("root".to_string());
        nodes.get_mut("child").expect("child exists").depth = 1;
        nodes.get_mut("Deep.txt").expect("deep exists").parent_id = Some("child".to_string());
        nodes.get_mut("Deep.txt").expect("deep exists").depth = 2;

        let graph = ScanGraph { nodes };
        let hits = graph.search("deep", 10);

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].node.id, "Deep.txt");
        assert_eq!(hits[0].ancestor_ids, vec!["root".to_string(), "child".to_string()]);
    }
}
