# pyDoctor

Browse Python package APIs in the browser: modules, classes, and functions, with signatures and docstrings.

**[pyDoctor](https://egranath.github.io/pyDoctor/)**

Builtins are loaded on a fresh visit. The rest of the standard library, along with numpy and sympy, sits in the catalog until you add a package from the sidebar. The address bar can also show PyPI metadata for a name that is not in the catalog. That is package info, not a loaded API.

The site is static. It does not run Python. To inspect a package that is not bundled, export its API and ingest the file from the sidebar:

```sh
python scripts/walk_package.py bleach bleach.json
```

Uploaded packages stay in the browser. Clearing them does not remove the bundled catalog.
