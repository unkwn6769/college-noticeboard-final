const FILE_TYPE_EXTENSIONS = {
  pdf: ['pdf'],
  documents: ['doc', 'docx', 'rtf', 'odt', 'txt'],
  spreadsheets: ['xls', 'xlsx', 'csv', 'ods'],
  presentations: ['ppt', 'pptx', 'odp'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
  code: ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'xml', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'sql'],
  text: ['md', 'log'],
};

const STORAGE_STATUSES = new Set(['pending', 'uploading', 'synced', 'failed']);

export function normalizeDriveFileSearchFilters(input = {}) {
  return {
    q: String(input.q ?? '').trim(),
    accountId: String(input.accountId ?? '').trim(),
    fileType: String(input.fileType ?? '').trim().toLowerCase(),
    status: String(input.status ?? '').trim().toLowerCase(),
    available: String(input.available ?? '').trim().toLowerCase(),
  };
}

export function buildDriveFileSearchWhere(filters, startIndex = 1) {
  const values = [];
  const clauses = ["r.type = 'file'"];
  let index = startIndex;

  if (filters.q) {
    const escaped = filters.q
      .replaceAll('\\', '\\\\')
      .replaceAll('%', '\\%')
      .replaceAll('_', '\\_');
    values.push(`%${escaped}%`);
    clauses.push(`(r.name ILIKE $${index} ESCAPE '\\' OR r.path ILIKE $${index} ESCAPE '\\' OR g.file_id ILIKE $${index} ESCAPE '\\')`);
    index += 1;
  }

  if (filters.accountId) {
    values.push(filters.accountId);
    clauses.push(`g.account_id = $${index}`);
    index += 1;
  }

  if (filters.fileType) {
    if (filters.fileType === 'no_extension') {
      clauses.push(`LOWER(r.name) NOT LIKE '%.%'`);
    } else if (filters.fileType === 'other') {
      const allKnown = Object.values(FILE_TYPE_EXTENSIONS).flat();
      const pattern = allKnown.map((value) => `\\.${value}$`).join('|');
      clauses.push(`LOWER(r.name) !~ '(${pattern})'`);
    } else if (FILE_TYPE_EXTENSIONS[filters.fileType]) {
      const pattern = FILE_TYPE_EXTENSIONS[filters.fileType]
        .map((value) => `\\.${value}$`)
        .join('|');
      clauses.push(`LOWER(r.name) ~ '(${pattern})'`);
    } else {
      throw new Error('Invalid file type filter');
    }
  }

  if (filters.status) {
    if (!STORAGE_STATUSES.has(filters.status)) {
      throw new Error('Invalid storage status filter');
    }
    values.push(filters.status);
    clauses.push(`r.storage_status = $${index}`);
    index += 1;
  }

  if (filters.available) {
    if (filters.available !== 'available' && filters.available !== 'unavailable') {
      throw new Error('Invalid availability filter');
    }
    clauses.push(`r.is_available = ${filters.available === 'available' ? 'TRUE' : 'FALSE'}`);
  }

  return { clauses, values, nextIndex: index };
}

export { FILE_TYPE_EXTENSIONS };
