import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import Department from "./pages/Department";
import FileViewer from "./pages/FileViewer";
import SearchResults from "./pages/SearchResults";

import AdminLogin from "./pages/admin/AdminLogin";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminAccounts from "./pages/admin/AdminAccounts";

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

      </Routes>
    </BrowserRouter>
  );
}

export default App;