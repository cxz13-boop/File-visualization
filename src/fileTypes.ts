export interface NewFileType {
  id: string;
  label: string;
  kind: "dir" | "file";
  extension: string | null;
}

export const NEW_FILE_TYPES: NewFileType[] = [
  { id: "folder", label: "文件夹", kind: "dir", extension: null },
  { id: "doc", label: ".doc", kind: "file", extension: ".doc" },
  { id: "docx", label: ".docx", kind: "file", extension: ".docx" },
  { id: "fpd", label: ".fpd", kind: "file", extension: ".fpd" },
  { id: "ppt", label: ".ppt", kind: "file", extension: ".ppt" },
  { id: "pptx", label: ".pptx", kind: "file", extension: ".pptx" },
  { id: "txt", label: ".txt", kind: "file", extension: ".txt" },
  { id: "md", label: ".md", kind: "file", extension: ".md" },
  { id: "xls", label: ".xls", kind: "file", extension: ".xls" },
  { id: "xlsx", label: ".xlsx", kind: "file", extension: ".xlsx" },
  { id: "zip", label: ".zip", kind: "file", extension: ".zip" },
  { id: "rar", label: ".rar", kind: "file", extension: ".rar" },
  { id: "7z", label: ".7z", kind: "file", extension: ".7z" },
  { id: "tar", label: ".tar", kind: "file", extension: ".tar" },
  { id: "gz", label: ".gz", kind: "file", extension: ".gz" },
  { id: "tar-gz", label: ".tar.gz", kind: "file", extension: ".tar.gz" },
  { id: "bz2", label: ".bz2", kind: "file", extension: ".bz2" },
  { id: "xz", label: ".xz", kind: "file", extension: ".xz" },
];
