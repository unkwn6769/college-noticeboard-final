import {
  Link,
  useParams,
  useSearchParams,
} from "react-router-dom";

import {
  useEffect,
  useState,
} from "react";

import {
  ArrowLeft,
  Bell,
  Download,
  Home,
  ChevronRight,
  FileText,
  File,
  FileSpreadsheet,
  ExternalLink
} from "lucide-react";

function FileViewer() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();

  const path = searchParams.get("path");
  const [fileUnavailable, setFileUnavailable] = useState(false);
  const [checkingFile, setCheckingFile] = useState(true);

  const from = searchParams.get("from");

  const backPath = from || `/noticeboards/${slug}/`;
  const backUrl = from
    ? `/department/${slug}?path=${encodeURIComponent(from)}`
    : `/department/${slug}`;

  if (!path) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center">
          <h1 className="text-2xl font-bold">
            File not found
          </h1>

          <Link
            to={backUrl}
            className="mt-4 inline-block rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white"
          >
            Back to department
          </Link>
        </div>
      </div>
    );
  }
  const breadcrumbParts = path
    .split("/")
    .filter(Boolean);

  const breadcrumbs = breadcrumbParts.map((part, index) => ({
    name: decodeURIComponent(part),
    path:
      "/" +
      breadcrumbParts
        .slice(0, index + 1)
        .join("/") +
      "/",
  }));

  const fileUrl = `http://localhost:3001/api/file?path=${encodeURIComponent(
    path
  )}`;

  useEffect(() => {
    let cancelled = false;

    async function checkFileStatus() {
      try {
        const response = await fetch(
          `http://localhost:3001/api/file-status?path=${encodeURIComponent(path)}`
        );

        if (!cancelled) {
          setFileUnavailable(response.status === 410);
        }
      } catch (error) {
        console.error("File status check failed:", error);
      } finally {
        if (!cancelled) {
          setCheckingFile(false);
        }
      }
    }

    checkFileStatus();

    return () => {
      cancelled = true;
    };
  }, [path]);

  const fileName = decodeURIComponent(
    path.split("/").filter(Boolean).pop() || "File"
  );


  const extension =
    fileName.includes(".")
      ? fileName.split(".").pop().toLowerCase()
      : "";



  const fileInfo = getFileInfo(extension);

  const isImage = [
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "svg",
  ].includes(extension);

  const isPdf = extension === "pdf";


  const isOffice = [
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
  ].includes(extension);

  if (checkingFile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
          <p className="mt-4 text-sm text-slate-500">
            Checking file availability...
          </p>
        </div>
      </div>
    );
  }

  if (fileUnavailable) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <div className="max-w-md text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-slate-100 text-slate-500">
            <File size={38} />
          </div>

          <h1 className="mt-6 text-2xl font-bold text-slate-900">
            File no longer available
          </h1>

          <p className="mt-3 text-sm leading-6 text-slate-500">
            This resource was previously found on the college
            noticeboard, but the original file is no longer
            available on the college server.
          </p>

          <Link
            to={backUrl}
            className="mt-6 inline-flex rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white"
          >
            Back to department
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">

      {/* NAVBAR */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">

          <Link
            to={`/department/${slug}`}
            className="flex items-center gap-3"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Bell size={20} />
            </div>

            <div>
              <p className="text-sm font-bold">
                College Notice Portal
              </p>

              <p className="text-xs text-slate-500">
                Official announcements
              </p>
            </div>
          </Link>

          <Link
            to={backUrl}
            className="flex items-center gap-2 text-sm font-medium text-slate-500 transition hover:text-slate-900"
          >
            <ArrowLeft size={16} />
            Back
          </Link>

        </div>
      </header>

      {/* MAIN */}
      <main className="mx-auto max-w-7xl px-6 py-10">
        <nav className="mb-6 flex items-center gap-1 overflow-x-auto text-sm">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1 text-slate-400 transition hover:text-slate-900"
          >
            <Home size={15} />
            Home
          </Link>

          {breadcrumbs.map((item, index) => {
            const isLast = index === breadcrumbs.length - 1;

            return (
              <div
                key={item.path}
                className="flex shrink-0 items-center gap-1"
              >
                <ChevronRight
                  size={15}
                  className="text-slate-300"
                />

                {isLast ? (
                  <span className="max-w-[420px] truncate font-semibold text-slate-700">
                    {item.name}
                  </span>
                ) : (
                  <Link
                    to={`/department/${slug}?path=${encodeURIComponent(
                      item.path
                    )}`}
                    className="max-w-[220px] truncate text-slate-400 transition hover:text-slate-900"
                  >
                    {item.name}
                  </Link>
                )}
              </div>
            );
          })}
        </nav>

        {/* FILE HEADER */}
        <section className="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">

          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">

            <div className="flex min-w-0 items-center gap-4">

              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
                <fileInfo.Icon size={26} />
              </div>

              <div className="min-w-0">

                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  {fileInfo.label}
                </p>

                <h1 className="mt-1 wrap-break-word text-xl font-bold tracking-tight sm:text-2xl">
                  {fileName}
                </h1>

                <p className="mt-1 text-sm text-slate-400">
                  {fileInfo.description}
                </p>

              </div>

            </div>

            <div className="flex shrink-0 gap-2">

              <a
                href={`${fileUrl}&download=1`}
                className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download size={16} />
                Download
              </a>

              <a
                href={fileUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                <ExternalLink size={16} />
                Open
              </a>

            </div>

          </div>

        </section>

        {/* VIEWER */}
        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">

          {isPdf && (
            <iframe
              src={fileUrl}
              title={fileName}
              className="h-[calc(100vh-260px)] w-full"
            />
          )}

          {isImage && (
            <div className="flex min-h-150 items-center justify-center bg-slate-100 p-8">
              <img
                src={fileUrl}
                alt={fileName}
                className="max-h-[calc(100vh-300px)] max-w-full rounded-xl object-contain shadow-sm"
              />
            </div>
          )}

          {isOffice && (
            <OfficePreview
              fileUrl={fileUrl}
              fileName={fileName}
              extension={extension}
            />
          )}

          {!isPdf && !isImage && !isOffice && (
            <UnsupportedPreview
              fileName={fileName}
              fileUrl={fileUrl}
            />
          )}

        </section>

      </main>
    </div>
  );
}
function OfficePreview({
  fileUrl,
  fileName,
  extension,
}) {
  return (
    <div className="flex min-h-150 flex-col items-center justify-center px-6 text-center">

      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-slate-100 text-slate-600">
        <FileSpreadsheet size={38} />
      </div>

      <p className="mt-6 text-xs font-bold uppercase tracking-widest text-slate-400">
        {extension.toUpperCase()} document
      </p>

      <h2 className="mt-2 max-w-xl wrap-break-word text-xl font-bold">
        {fileName}
      </h2>

      <p className="mt-3 max-w-lg text-sm leading-6 text-slate-500">
        This document is available from the college notice
        server. Browser support for Office documents varies,
        so use Open or Download to access the original file.
      </p>

      <div className="mt-6 flex gap-3">

        <a
          href={fileUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
        >
          <ExternalLink size={16} />
          Open
        </a>

        <a
          href={`${fileUrl}&download=1`}
          className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <Download size={16} />
          Download
        </a>

      </div>

    </div>
  );
}

/*
 * Unsupported / browser-dependent file preview
 */
function UnsupportedPreview({
  fileName,
  fileUrl,
}) {
  return (
    <div className="flex min-h-150 flex-col items-center justify-center px-6 text-center">

      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-slate-100 text-slate-600">
        <File size={38} />
      </div>

      <p className="mt-6 text-xs font-bold uppercase tracking-widest text-slate-400">
        File
      </p>

      <h2 className="mt-2 max-w-xl wrap-break-word text-xl font-bold">
        {fileName}
      </h2>

      <p className="mt-3 max-w-lg text-sm leading-6 text-slate-500">
        Preview is not available for this file type.
        You can open or download the original college resource.
      </p>

      <div className="mt-6 flex gap-3">

        <a
          href={fileUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
        >
          <ExternalLink size={16} />
          Open
        </a>

        <a
          href={`${fileUrl}&download=1`}
          className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <Download size={16} />
          Download
        </a>

      </div>

    </div>
  );
}
/*
 * File type information
 */
function getFileInfo(extension) {
  switch (extension) {
    case "pdf":
      return {
        label: "PDF Document",
        description: "Portable Document Format",
        Icon: FileText,
      };

    case "doc":
    case "docx":
      return {
        label: "Word Document",
        description: "Microsoft Word document",
        Icon: FileText,
      };

    case "xls":
    case "xlsx":
    case "csv":
      return {
        label: "Spreadsheet",
        description: "Spreadsheet document",
        Icon: FileSpreadsheet,
      };

    case "ppt":
    case "pptx":
      return {
        label: "Presentation",
        description: "Microsoft PowerPoint presentation",
        Icon: Presentation,
      };

    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
      return {
        label: "Image",
        description: "Image file",
        Icon: Image,
      };

    case "zip":
    case "rar":
    case "7z":
      return {
        label: "Archive",
        description: "Compressed archive",
        Icon: File,
      };

    default:
      return {
        label: "File",
        description: "College resource",
        Icon: File,
      };
  }
}

export default FileViewer;