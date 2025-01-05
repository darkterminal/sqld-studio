"use client";
import { createClient, ResultSet } from "@libsql/client/web";
import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

function App() {
  const [clientUrl, setClientUrl] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState<string>("SQLD Studio");

  // Function to get URL parameters
  const getUrlParams = () => {
    const urlParams = new URLSearchParams(window.location.search);
    return {
      url: urlParams.get("url") || "",
      token: urlParams.get("authToken") || "", // Rename authToken to token
      title: urlParams.get('name') + " - SQLD Studio" || "SQLD Studio"
    };
  };

  // Get URL parameters
  const { url, token, title } = getUrlParams();

  // Save to localStorage and update state
  useEffect(() => {
    if (url && token) {
      localStorage.setItem("clientUrl", url);
      localStorage.setItem("authToken", token);
      localStorage.setItem("title", pageTitle);

      setClientUrl(url);
      setAuthToken(token);

      // Clear URL parameters from the address bar by updating the history
      window.history.replaceState({}, "", window.location.pathname);
    }

    setPageTitle(pageTitle);
    document.title = pageTitle

    // Clear localStorage when the tab or window is closed
    const handleBeforeUnload = () => {
      localStorage.removeItem("clientUrl");
      localStorage.removeItem("authToken");
      localStorage.removeItem("title");
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    // Cleanup event listener on component unmount
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [url, token, pageTitle]);

  document.title = title;

  // Prepare hooks before conditional rendering
  const client = useMemo(() => {
    if (!clientUrl || !authToken) return null;
    return createClient({
      url: clientUrl,
      authToken: authToken,
    });
  }, [clientUrl, authToken]);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Effect for iframe messaging
  useEffect(() => {
    if (!client) return;

    const contentWindow = iframeRef.current?.contentWindow;

    if (contentWindow) {
      const handler = (e: MessageEvent<ClientRequest>) => {
        if (e.data.type === "query" && e.data.statement) {
          client
            .execute(e.data.statement)
            .then((r) => {
              contentWindow.postMessage(
                {
                  type: e.data.type,
                  id: e.data.id,
                  data: transformRawResult(r),
                },
                "*"
              );
            })
            .catch((err) => {
              contentWindow.postMessage(
                {
                  type: e.data.type,
                  id: e.data.id,
                  error: (err as Error).message,
                },
                "*"
              );
            });
        } else if (e.data.type === "transaction" && e.data.statements) {
          client
            .batch(e.data.statements, "write")
            .then((r) => {
              contentWindow.postMessage(
                {
                  type: e.data.type,
                  id: e.data.id,
                  data: r.map(transformRawResult),
                },
                "*"
              );
            })
            .catch((err) => {
              contentWindow.postMessage(
                {
                  type: e.data.type,
                  id: e.data.id,
                  error: (err as Error).message,
                },
                "*"
              );
            });
        }
      };

      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }
  }, [iframeRef, client]);

  // If clientUrl or authToken is still missing, show the input form
  if (!clientUrl || !authToken) {
    return (
      <div className="full-screen-borderless">
        <div className="form-container">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // Set the values in localStorage and state
              localStorage.setItem("clientUrl", clientUrl || "");
              localStorage.setItem("authToken", authToken || "");
              window.location.reload();
            }}
          >
            <h2>Enter Client URL and Auth Token</h2>
            <label>
              Client URL:
              <input
                type="text"
                value={clientUrl || ""}
                onChange={(e) => setClientUrl(e.target.value)}
                placeholder="Enter Client URL"
                required
              />
            </label>
            <label>
              Auth Token:
              <input
                type="text"
                value={authToken || ""}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="Enter Auth Token"
                required
              />
            </label>
            <button type="submit">Submit</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <iframe
      className="full-screen-borderless"
      ref={iframeRef}
      src="https://libsqlstudio.com/embed/sqlite"
    />
  );
}

interface ClientRequest {
  type: "query" | "transaction";
  id: number;
  statement?: string;
  statements?: string[];
}

interface ResultHeader {
  name: string;
  displayName: string;
  originalType: string | null;
  type: ColumnType;
}

interface Result {
  rows: Record<string, unknown>[];
  headers: ResultHeader[];
  stat: {
    rowsAffected: number;
    rowsRead: number | null;
    rowsWritten: number | null;
    queryDurationMs: number | null;
  };
  lastInsertRowid?: number;
}

enum ColumnType {
  TEXT = 1,
  INTEGER = 2,
  REAL = 3,
  BLOB = 4,
}

function convertSqliteType(type: string | undefined): ColumnType {
  if (type === undefined) return ColumnType.BLOB;

  type = type.toUpperCase();

  if (type.includes("CHAR")) return ColumnType.TEXT;
  if (type.includes("TEXT")) return ColumnType.TEXT;
  if (type.includes("CLOB")) return ColumnType.TEXT;
  if (type.includes("STRING")) return ColumnType.TEXT;

  if (type.includes("INT")) return ColumnType.INTEGER;

  if (type.includes("BLOB")) return ColumnType.BLOB;

  if (
    type.includes("REAL") ||
    type.includes("DOUBLE") ||
    type.includes("FLOAT")
  )
    return ColumnType.REAL;

  return ColumnType.TEXT;
}

function transformRawResult(raw: ResultSet): Result {
  const headerSet = new Set();

  const headers: ResultHeader[] = raw.columns.map((colName, colIdx) => {
    const colType = raw.columnTypes[colIdx];
    let renameColName = colName;

    for (let i = 0; i < 20; i++) {
      if (!headerSet.has(renameColName)) break;
      renameColName = `__${colName}_${i}`;
    }

    headerSet.add(renameColName);

    return {
      name: renameColName,
      displayName: colName,
      originalType: colType,
      type: convertSqliteType(colType),
    };
  });

  const rows = raw.rows.map((r) =>
    headers.reduce((a, b, idx) => {
      a[b.name] = r[idx];
      return a;
    }, {} as Record<string, unknown>)
  );

  return {
    rows,
    stat: {
      rowsAffected: raw.rowsAffected,
      rowsRead: null,
      rowsWritten: null,
      queryDurationMs: 0,
    },
    headers,
    lastInsertRowid:
      raw.lastInsertRowid === undefined
        ? undefined
        : Number(raw.lastInsertRowid),
  };
}

export default App;
