const GROUPS = [
  { key: 'pdf', label: 'PDF', extensions: ['pdf'] },
  { key: 'documents', label: 'Documents', extensions: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md'] },
  { key: 'spreadsheets', label: 'Spreadsheets', extensions: ['xls', 'xlsx', 'csv', 'ods', 'tsv'] },
  { key: 'presentations', label: 'Presentations', extensions: ['ppt', 'pptx', 'odp', 'key'] },
  { key: 'images', label: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'ico', 'heic'] },
  { key: 'video', label: 'Video', extensions: ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'mpeg', 'mpg'] },
  { key: 'audio', label: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'wma'] },
  { key: 'archives', label: 'Archives', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'] },
  { key: 'code', label: 'Code', extensions: ['js', 'jsx', 'ts', 'tsx', 'json', 'css', 'html', 'htm', 'java', 'c', 'cpp', 'h', 'hpp', 'py', 'go', 'rs', 'php', 'sql', 'sh', 'xml', 'yml', 'yaml'] },
];

const extensionToGroup = new Map(
  GROUPS.flatMap((group) => group.extensions.map((extension) => [extension, group]))
);

export function classifyFileType(name) {
  const value = String(name ?? '').trim().toLowerCase();
  const basename = value.split('/').pop() ?? value;
  const match = basename.match(/\.([a-z0-9]{1,15})$/i);
  const extension = match?.[1] ?? '';
  const group = extensionToGroup.get(extension);

  if (group) {
    return { key: group.key, label: group.label, extension };
  }

  if (!extension) return { key: 'unknown', label: 'Unknown / no extension', extension: '' };
  return { key: 'other', label: 'Other', extension };
}

export function getFileTypeExtensions(key) {
  if (key === 'unknown') return { mode: 'unknown', extensions: [] };
  if (key === 'other') return { mode: 'other', extensions: [...extensionToGroup.keys()] };
  const group = GROUPS.find((candidate) => candidate.key === key);
  return group ? { mode: 'extensions', extensions: [...group.extensions] } : null;
}

export function aggregateFileTypes(rows) {
  const groups = new Map();
  let totalFiles = 0;
  let knownSizeFiles = 0;
  let unknownSizeFiles = 0;
  let totalBytes = 0n;

  for (const row of rows) {
    totalFiles += 1;
    const type = classifyFileType(row.name);
    const bytes = row.sizeBytes == null ? null : BigInt(row.sizeBytes);

    if (bytes == null) unknownSizeFiles += 1;
    else {
      knownSizeFiles += 1;
      totalBytes += bytes >= 0n ? bytes : 0n;
    }

    let group = groups.get(type.key);
    if (!group) {
      group = {
        key: type.key,
        label: type.label,
        fileCount: 0,
        sizeBytes: 0n,
        unknownSizeCount: 0,
        extensions: new Set(),
      };
      groups.set(type.key, group);
    }

    group.fileCount += 1;
    if (bytes == null) group.unknownSizeCount += 1;
    else if (bytes >= 0n) group.sizeBytes += bytes;
    if (type.extension) group.extensions.add(type.extension);
  }

  const normalizedGroups = [...groups.values()]
    .sort((a, b) => (b.sizeBytes > a.sizeBytes ? 1 : b.sizeBytes < a.sizeBytes ? -1 : b.fileCount - a.fileCount))
    .map((group) => ({
      key: group.key,
      label: group.label,
      fileCount: group.fileCount,
      sizeBytes: group.sizeBytes.toString(),
      unknownSizeCount: group.unknownSizeCount,
      extensions: [...group.extensions].sort(),
      percent: totalBytes > 0n ? Number((group.sizeBytes * 10000n) / totalBytes) / 100 : 0,
    }));

  return {
    totalFiles,
    knownSizeFiles,
    unknownSizeFiles,
    totalBytes: totalBytes.toString(),
    groups: normalizedGroups,
  };
}
