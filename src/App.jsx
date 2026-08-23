import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import Department from "./pages/Department";
import FileViewer from "./pages/FileViewer";
import SearchResults from "./pages/SearchResults";

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

      </Routes>
    </BrowserRouter>
  );
}

export default App;