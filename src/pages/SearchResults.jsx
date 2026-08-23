import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Building2,
  FileText,
  Search,
} from "lucide-react";

function SearchResults() {
  const [searchParams] = useSearchParams();

  const query = searchParams.get("q")?.trim() || "";

  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();

    async function loadResults() {
      try {
        setLoading(true);

        const response = await fetch(
          `http://localhost:3001/api/search?q=${encodeURIComponent(query)}`,
          {
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error("Search failed");
        }

        const data = await response.json();

        setResults(data.results || []);
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error(error);
          setResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    loadResults();

    return () => controller.abort();
  }, [query]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">

      {/* NAVBAR */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">

          <Link to="/" className="flex items-center gap-3">

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

      {/* MAIN */}
      <main className="mx-auto max-w-5xl px-6 py-12">

        <div className="mb-8">

          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Search
          </p>

          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Results for "{query}"
          </h1>

          {!loading && (
            <p className="mt-2 text-sm text-slate-500">
              {results.length} matching resources
            </p>
          )}

        </div>

        {loading ? (

          <div className="rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center">
            <Search
              size={24}
              className="mx-auto text-slate-300"
            />

            <p className="mt-3 text-sm text-slate-500">
              Searching...
            </p>
          </div>

        ) : results.length === 0 ? (

          <div className="rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center">

            <Search
              size={24}
              className="mx-auto text-slate-300"
            />

            <h2 className="mt-4 text-lg font-semibold">
              No results found
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Try a different search term.
            </p>

          </div>

        ) : (

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">

            {results.map((result) => {

              const path = result.path;

              const href =
                result.type === "folder"
                  ? `/department/${result.department}?path=${encodeURIComponent(
                      path
                    )}`
                  : `/file/${result.department}?path=${encodeURIComponent(
                      path
                    )}`;

              return (
                <a
                  key={`${result.department}-${result.url}`}
                  href={href}
                  className="group block border-b border-slate-100 px-6 py-5 transition last:border-b-0 hover:bg-slate-50"
                >

                  <div className="flex items-start gap-4">

                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100">

                      {result.type === "folder" ? (
                        <Building2
                          size={18}
                          className="text-slate-500"
                        />
                      ) : (
                        <FileText
                          size={18}
                          className="text-slate-500"
                        />
                      )}

                    </div>

                    <div className="min-w-0 flex-1">

                      <h2 className="font-semibold text-slate-800">
                        {result.name}
                      </h2>

                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">

                        <span>
                          {result.department}
                        </span>

                        <span>•</span>

                        <span>
                          {result.type === "folder"
                            ? "Folder"
                            : "File"}
                        </span>

                        {result.date && (
                          <>
                            <span>•</span>

                            <span>
                              {formatDate(result.date)}
                            </span>
                          </>
                        )}

                      </div>

                    </div>

                    <ArrowUpRight
                      size={18}
                      className="mt-1 shrink-0 text-slate-300 transition group-hover:text-slate-900"
                    />

                  </div>

                </a>
              );
            })}

          </div>
        )}

      </main>
    </div>
  );
}

export default SearchResults;