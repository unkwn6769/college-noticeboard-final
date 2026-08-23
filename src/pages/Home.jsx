import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  Search,
  ChevronRight,
  ArrowUpRight,
  Code2,
  BrainCircuit,
  Database,
  Network,
  Monitor,
  Radio,
  Zap,
  Gauge,
  Globe,
  Cog,
  Building2,
  FileText,
  Megaphone,
  BookOpen,
  Cpu,
} from "lucide-react";

import { departments } from "../data/departments";

const icons = {
  Code2,
  BrainCircuit,
  Database,
  Network,
  Monitor,
  Radio,
  Zap,
  Gauge,
  Globe,
  Cog,
  Building2,
  FileText,
  Megaphone,
  BookOpen,
  Cpu,
};

function Home() {
  const [departmentStats, setDepartmentStats] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [overview, setOverview] = useState({
    totalResources: 0,
    latestUpdate: null,
    loading: true,
  });
  useEffect(() => {
    async function loadOverview() {
      try {
        setOverview((prev) => ({
          ...prev,
          loading: true,
        }));

        const response = await fetch(
          "http://localhost:3001/api/overview"
        );

        if (!response.ok) {
          throw new Error("Failed to load overview");
        }

        const data = await response.json();

        const stats = {};

        data.departments.forEach((department) => {
          stats[department.slug] = {
            unavailable: !department.available,
            status: department.status,
            count: department.count,
            latestUpdate: department.latestUpdate
              ? new Date(department.latestUpdate)
              : null,
          };
        });

        setDepartmentStats(stats);

        const availableDepartments =
          data.departments.filter(
            (department) => department.available
          );

        const totalResources =
          availableDepartments.reduce(
            (total, department) =>
              total + department.count,
            0
          );

        const latestUpdate =
          availableDepartments.reduce(
            (latest, department) => {
              if (!department.latestUpdate) {
                return latest;
              }

              const date = new Date(
                department.latestUpdate
              );

              if (!latest || date > latest) {
                return date;
              }

              return latest;
            },
            null
          );

        setOverview({
          totalResources,
          latestUpdate,
          loading: false,
        });
      } catch (error) {
        console.error(error);

        setOverview((prev) => ({
          ...prev,
          loading: false,
        }));
      }
    }

    loadOverview();
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();

    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        setSearchLoading(true);

        const response = await fetch(
          `http://localhost:3001/api/search?q=${encodeURIComponent(
            query
          )}`,
          {
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error("Search failed");
        }

        const data = await response.json();

        setSearchResults(data.results || []);
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error(error);
          setSearchResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setSearchLoading(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">

      {/* NAVBAR */}
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">

          <div className="flex items-center gap-3">

            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Bell size={20} />
            </div>

            <div>
              <h1 className="text-sm font-bold">
                College Notice Portal
              </h1>

              <p className="text-xs text-slate-500">
                Official announcements
              </p>
            </div>

          </div>

          <nav className="hidden items-center gap-7 md:flex">
            <a
              href="/"
              className="text-sm font-semibold text-slate-900"
            >
              Dashboard
            </a>

            <a
              href="#departments"
              className="text-sm font-medium text-slate-500 hover:text-slate-900"
            >
              Departments
            </a>
          </nav>

        </div>
      </header>

      {/* MAIN */}
      <main className="mx-auto max-w-7xl px-6 py-14">

        {/* HERO */}
        <section className="max-w-3xl">

          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">

            <span className="h-2 w-2 rounded-full bg-emerald-500" />

            Notice board online

          </div>

          <h2 className="mt-6 text-5xl font-bold leading-[1.05] tracking-tight text-slate-950 md:text-6xl">

            Everything important,
            <br />

            <span className="text-slate-400">
              in one place.
            </span>

          </h2>

          <p className="mt-6 max-w-2xl text-base leading-7 text-slate-500 md:text-lg">

            Access academic announcements, examination notices,
            departmental updates and other official college information.

          </p>

          {/* SEARCH */}
          <div className="relative mt-8 max-w-xl">
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <Search
                size={20}
                className="text-slate-400"
              />

              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search departments or notices..."
                className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
              />

              <kbd className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-400">
                /
              </kbd>
            </div>

            {searchQuery.trim() && (
              <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
                {searchLoading ? (
                  <div className="px-4 py-5 text-sm text-slate-500">
                    Searching...
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="px-4 py-5 text-sm text-slate-500">
                    No matching resources found.
                  </div>
                ) : (
                  <div className="max-h-96 overflow-y-auto">
                    {searchResults.slice(0, 8).map((result) => (
                      <a
                        key={`${result.department}-${result.url}`}
                        href={
                          result.type === "folder"
                            ? `/department/${result.department}?path=${encodeURIComponent(
                              result.path
                            )}`
                            : `/file/${result.department}?path=${encodeURIComponent(
                              result.path
                            )}`
                        }
                        className="block border-b border-slate-100 px-4 py-3 transition hover:bg-slate-50 last:border-b-0"
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                            {result.type === "folder" ? (
                              <Building2
                                size={16}
                                className="text-slate-500"
                              />
                            ) : (
                              <FileText
                                size={16}
                                className="text-slate-500"
                              />
                            )}
                          </div>

                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-800">
                              {result.name}
                            </p>

                            <p className="mt-1 text-xs text-slate-400">
                              {result.department}
                              {" • "}
                              {result.type === "folder"
                                ? "Folder"
                                : "File"}
                            </p>
                          </div>

                          <ArrowUpRight
                            size={16}
                            className="ml-auto shrink-0 text-slate-300"
                          />
                        </div>
                      </a>
                    ))}
                    {searchResults.length > 8 && (
                      <Link
                        to={`/search?q=${encodeURIComponent(searchQuery.trim())}`}
                        className="block border-t border-slate-100 px-4 py-3 text-center text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                      >
                        View all {searchResults.length} results
                      </Link>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

        </section>

        {/* STATS */}
        <section className="mt-12 grid gap-4 sm:grid-cols-3">

          <Stat
            number={departments.length}
            label="Departments"
          />

          <Stat
            number={
              overview.loading
                ? "..."
                : overview.totalResources
            }
            label="Top-level resources"
          />

          <Stat
            number={
              overview.loading
                ? "..."
                : overview.latestUpdate
                  ? formatRelativeDate(overview.latestUpdate)
                  : "—"
            }
            label="Latest directory update"
          />

        </section>

        {/* DEPARTMENTS */}
        <section
          id="departments"
          className="mt-16"
        >

          <div className="mb-7 flex items-end justify-between">

            <div>
              <p className="text-xs font-semibold tracking-widest text-slate-400">
                EXPLORE
              </p>

              <h3 className="mt-1 text-2xl font-bold tracking-tight">
                Departments
              </h3>
            </div>

            <button className="hidden items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-900 sm:flex">
              View all
              <ChevronRight size={16} />
            </button>

          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">

            {departments.map((department) => (
              <DepartmentCard
                key={department.slug}
                department={department}
                stats={departmentStats[department.slug]}
              />
            ))}

          </div>

        </section>

      </main>

      {/* FOOTER */}
      <footer className="mt-20 border-t border-slate-200 bg-white">

        <div className="mx-auto flex max-w-7xl justify-between px-6 py-8 text-sm text-slate-400">

          <span>
            College Notice Portal
          </span>

          <span>
            Official college information
          </span>

        </div>

      </footer>

    </div>
  );
}

function Stat({ number, label }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6">

      <p className="text-3xl font-bold tracking-tight">
        {number}
      </p>

      <p className="mt-1 text-sm text-slate-500">
        {label}
      </p>

    </div>
  );
}

function DepartmentCard({ department, stats }) {

  const Icon = icons[department.icon];

  return (
    <a
      href={`/department/${department.slug}`}
      className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-1 hover:border-slate-300 hover:shadow-lg"
    >

      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700 transition group-hover:bg-slate-900 group-hover:text-white">

        <Icon size={22} />

      </div>

      <div className="min-w-0 flex-1">

        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          {department.shortName}
        </p>

        <h4 className="mt-1 line-clamp-2 text-sm font-semibold leading-5">
          {department.name}
        </h4>

        <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
          <span>
            {!stats ? (
              "Loading..."
            ) : stats.unavailable ? (
              <span className="text-amber-600">
                Temporarily unavailable
              </span>
            ) : (
              `${stats.count} resources`
            )}
          </span>

          {stats?.unavailable ? (
            <>
              <span>•</span>
              <span className="text-amber-600">
                Server unavailable
              </span>
            </>
          ) : stats?.latestUpdate ? (
            <>
              <span>•</span>
              <span>
                {formatRelativeDate(stats.latestUpdate)}
              </span>
            </>
          ) : null}
        </div>

      </div>

      <ArrowUpRight
        size={18}
        className="shrink-0 text-slate-300 transition group-hover:text-slate-900"
      />

    </a>
  );
}
function formatRelativeDate(date) {
  const now = new Date();

  const difference =
    now.getTime() - date.getTime();

  const days = Math.floor(
    difference / (1000 * 60 * 60 * 24)
  );

  if (days === 0) {
    return "Today";
  }

  if (days === 1) {
    return "Yesterday";
  }

  if (days < 30) {
    return `${days}d ago`;
  }

  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default Home;