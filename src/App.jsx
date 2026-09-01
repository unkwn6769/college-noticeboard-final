import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import Department from "./pages/Department";
import FileViewer from "./pages/FileViewer";
import SearchResults from "./pages/SearchResults";

import AdminLogin from "./pages/admin/AdminLogin";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminAccounts from "./pages/admin/AdminAccounts";
import AdminStorage from "./pages/admin/AdminStorage";
import AdminStorageFileTypes from "./pages/admin/AdminStorageFileTypes";
import AdminManagement from "./pages/admin/AdminManagement";
import AdminDriveFiles from "./pages/admin/AdminDriveFiles";
import AdminDriveFileSearch from "./pages/admin/AdminDriveFileSearch";
import AdminActivity from "./pages/admin/AdminActivity";
import AdminRecycleBin from "./pages/admin/AdminRecycleBin";
import AdminStorageHealth from "./pages/admin/AdminStorageHealth";
import AdminSourceRetention from "./pages/admin/AdminSourceRetention";

function App() {
  return (
    <BrowserRouter>
      <Routes>

        <Route
          path="/"
          element={<Home />}
        />

        <Route
          path="/search"
          element={<SearchResults />}
        />

        <Route
          path="/department/:slug"
          element={<Department />}
        />

        <Route
          path="/file/:slug"
          element={<FileViewer />}
        />

        <Route
          path="/admin/login"
          element={<AdminLogin />}
        />

        <Route
          path="/admin"
          element={<AdminDashboard />}
        />

        <Route
          path="/admin/accounts"
          element={<AdminAccounts />}
        />

        <Route
          path="/admin/storage"
          element={<AdminStorage />}
        />

        <Route
          path="/admin/storage/health"
          element={<AdminStorageHealth />}
        />

        <Route
          path="/admin/storage/file-types"
          element={<AdminStorageFileTypes />}
        />

        <Route
          path="/admin/accounts/:accountId/files"
          element={<AdminDriveFiles />}
        />

        <Route
          path="/admin/file-search"
          element={<AdminDriveFileSearch />}
        />

        <Route
          path="/admin/admins"
          element={<AdminManagement />}
        />

        <Route
          path="/admin/activity"
          element={<AdminActivity />}
        />

        <Route
          path="/admin/recycle-bin"
          element={<AdminRecycleBin />}
        />

        <Route
          path="/admin/source-retention"
          element={<AdminSourceRetention />}
        />

      </Routes>
    </BrowserRouter>
  );
}

export default App;