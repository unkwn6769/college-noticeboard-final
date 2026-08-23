import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Bell,
  File,
  FileText,
  FileSpreadsheet,
  Presentation,
  Image,
  Folder,
  Search,
  ChevronRight,
  Home,
} from "lucide-react";

import { departments } from "../data/departments";
import { API_URL } from "../config/api";

function Department() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();

  const department = departments.find(
    (item) => item.slug === slug
  );

  // If there is no ?path=..., show the department root.
  // Otherwise show the folder specified by ?path=...
  const currentPath =
    searchParams.get("path") ||
    `/noticeboards/${slug}/`;

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("name");

  useEffect(() => {
    if (!department) return;

    async function loadDirectory() {
      try {
        setLoading(true);
        setError("");

        const response = await fetch(
          `${API_URL}/api/browse?path=${encodeURIComponent(currentPath)}`
        );

        if (!response.ok) {
          throw new Error("Failed to load directory");
        }

        const data = await response.json();

        setItems(data.items);
      } catch (err) {
        console.error(err);
        setError("Unable to load department resources.");
      } finally {
        setLoading(false);
      }
    }

    loadDirectory();
  }, [currentPath, department]);

  if (!department) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">

          <h1 className="text-3xl font-bold">
            Department not found
          </h1>

          <Link
            to="/"
            className="mt-5 inline-block rounded-xl bg-slate-900 px-5 py-3 text-sm text-white"
          >
            Back to home
          </Link>

        </div>
      </div>
    );
  }

  /*
   * Example:
   *
   * /noticeboards/cse-noticeboard/
   *
   * becomes:
   *
   * ["noticeboards", "cse-noticeboard"]
   *
   * If inside CIRCULARS:
   *
   * /noticeboards/cse-noticeboard/CIRCULARS/
   *
   * becomes:
   *
   * ["noticeboards", "cse-noticeboard", "CIRCULARS"]
   */

  const pathParts = currentPath
    .split("/")
    .filter(Boolean);

  const isRoot =
    currentPath === `/noticeboards/${slug}/`;

  const currentFolderName = isRoot
    ? department.shortName
    : decodeURIComponent(
      pathParts[pathParts.length - 1]
    );
  const filteredItems = items
    .filter((item) =>
      item.name
        .toLowerCase()
        .includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      // Keep folders before files
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }

      if (sortBy === "name") {
        return a.name.localeCompare(b.name);
      }

      if (sortBy === "newest") {
        return new Date(b.date) - new Date(a.date);
      }

      if (sortBy === "oldest") {
        return new Date(a.date) - new Date(b.date);
      }

      return 0;
    });

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">

      {/* NAVBAR */}

      <header className="border-b border-slate-200 bg-white">

        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">

          <Link
            to="/"
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
            to="/"
            className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"
          >
            <ArrowLeft size={16} />
            Back
          </Link>

        </div>

      </header>

      <main className="mx-auto max-w-5xl px-6 py-12">
        {/* BREADCRUMB */}

        <div className="mb-8 flex flex-wrap items-center gap-2 text-sm text-slate-400">

          <Link
            to="/"
            className="flex items-center gap-1 hover:text-slate-900"
          >
            <Home size={14} />
            Home
          </Link>

          <span>/</span>

          <Link
            to={`/department/${slug}`}
            className="hover:text-slate-900"
          >
            {department.shortName}
          </Link>

          {pathParts.length > 2 &&
            pathParts.slice(2).map((part, index) => {

              const decodedPart = decodeURIComponent(part);

              const pathUpToHere =
                "/" +
                pathParts
                  .slice(0, index + 3)
                  .join("/") +
                "/";

              const isLast =
                index === pathParts.slice(2).length - 1;

              return (
                <div
                  key={pathUpToHere}
                  className="flex items-center gap-2"
                >

                  <span>/</span>

                  {isLast ? (
                    <span className="font-medium text-slate-600">
                      {decodedPart}
                    </span>
                  ) : (
                    <Link
                      to={`/department/${slug}?path=${encodeURIComponent(
                        pathUpToHere
                      )}`}
                      className="hover:text-slate-900"
                    >
                      {decodedPart}
                    </Link>
                  )}

                </div>
              );
            })}

        </div>

        {/* HEADER */}

        <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">

          <div className="flex items-start gap-5">

            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <Bell size={25} />
            </div>

            <div className="min-w-0">

              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                {department.shortName}
              </p>

              <h1 className="mt-2 text-3xl font-bold tracking-tight">
                {isRoot
                  ? department.name
                  : currentFolderName}
              </h1>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                {isRoot
                  ? "Browse official department resources, documents and announcements."
                  : `Browse resources inside ${currentFolderName}.`}
              </p>

            </div>

          </div>

        </section>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">

          {/* SEARCH */}

          <div className="flex flex-1 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">

            <Search
              size={19}
              className="text-slate-400"
            />

            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search this directory..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
            />

          </div>

          {/* SORT */}

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 outline-none shadow-sm"
          >

            <option value="name">
              Sort: Name
            </option>

            <option value="newest">
              Sort: Newest
            </option>

            <option value="oldest">
              Sort: Oldest
            </option>

          </select>

        </div>

        {/* CONTENT HEADER */}

        <div className="mt-12">

          <div className="mb-5 flex items-end justify-between">

            <div>
              <p className="text-xs font-bold tracking-widest text-slate-400">
                {isRoot ? "RESOURCES" : "DIRECTORY"}
              </p>

              <h2 className="mt-1 text-2xl font-bold">
                {currentFolderName}
              </h2>
            </div>

            {!loading && (
              <span className="text-sm text-slate-400">
                {filteredItems.length} items
              </span>
            )}

          </div>

          {/* LOADING */}

          {loading && (
            <div className="space-y-3">

              {[1, 2, 3, 4, 5].map((item) => (
                <div
                  key={item}
                  className="h-20 animate-pulse rounded-2xl bg-slate-200"
                />
              ))}

            </div>
          )}

          {/* ERROR */}

          {!loading && error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* ITEMS */}

          {!loading && !error && (
            <div className="space-y-3">

              {filteredItems.map((item) => {

                const itemPath = item.path;
                if (item.type === "folder") {

                  return (
                    <Link
                      key={item.path}
                      to={`/department/${slug}?path=${encodeURIComponent(
                        itemPath
                      )}`}
                      className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                    >

                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                        <Folder size={21} />
                      </div>

                      <div className="min-w-0 flex-1">

                        <h3 className="truncate text-sm font-semibold">
                          {item.name}
                        </h3>

                        <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">

                          <span>
                            Folder
                          </span>

                          <span>•</span>

                          <span>
                            {formatDate(item.date)}
                          </span>

                        </div>

                      </div>

                      <ChevronRight
                        size={18}
                        className="shrink-0 text-slate-300 transition group-hover:translate-x-1 group-hover:text-slate-900"
                      />

                    </Link>
                  );
                }
                const FileIcon = getFileIcon(item.name);
                return (
                  <Link
                    key={item.path}
                    to={`/file/${slug}?path=${encodeURIComponent(
                      item.path
                    )}&from=${encodeURIComponent(currentPath)}`}
                    className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                  >

                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                      <FileIcon size={21} />
                    </div>

                    <div className="min-w-0 flex-1">

                      <h3 className="truncate text-sm font-semibold">
                        {item.name}
                      </h3>

                      <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">

                        <span>
                          File
                        </span>

                        <span>•</span>

                        <span>
                          {formatDate(item.date)}
                        </span>

                        {item.size && (
                          <>
                            <span>•</span>

                            <span>
                              {formatSize(item.size)}
                            </span>
                          </>
                        )}

                      </div>

                    </div>

                    <ChevronRight
                      size={18}
                      className="shrink-0 text-slate-300 transition group-hover:text-slate-900"
                    />

                  </Link>
                );
              })}

            </div>
          )}

        </div>

      </main>

    </div>
  );
}

function formatDate(date) {
  if (!date) return "";

  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getFileIcon(filename) {
  const extension = filename
    .split(".")
    .pop()
    .toLowerCase();

  switch (extension) {
    case "pdf":
      return FileText;

    case "doc":
    case "docx":
      return FileText;

    case "xls":
    case "xlsx":
    case "csv":
      return FileSpreadsheet;

    case "ppt":
    case "pptx":
      return Presentation;

    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
      return Image;

    default:
      return File;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default Department;