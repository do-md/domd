import AppKit
import QuickLookUI
import WebKit

final class PreviewViewController: NSViewController, QLPreviewingController, WKNavigationDelegate {
    private var webView: WKWebView!
    private var schemeHandler: PreviewURLSchemeHandler?
    private var loadContinuation: CheckedContinuation<Void, Error>?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false
        if #available(macOS 11.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }

        if let webBase = Self.webResourceURL() {
            let handler = PreviewURLSchemeHandler(root: webBase)
            self.schemeHandler = handler
            config.setURLSchemeHandler(handler, forURLScheme: "domd")
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        self.webView = webView
        self.view = webView
        NSLog("[DOMDPreview] loadView done, webBase=%@", Self.webResourceURL()?.path ?? "nil")
    }

    func preparePreviewOfFile(at url: URL) async throws {
        NSLog("[DOMDPreview] prepare url=%@", url.path)
        _ = self.view
        let markdown = try Self.readMarkdown(from: url)
        NSLog("[DOMDPreview] read md len=%d", markdown.count)

        let parentDir = url.deletingLastPathComponent().path
        let injection = """
            window.__DOMD_PREVIEW_CONTENT__ = \(Self.jsStringLiteral(markdown));
            window.__DOMD_PREVIEW_DIR__ = \(Self.jsStringLiteral(parentDir));
            """
        let userScript = WKUserScript(
            source: injection,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(userScript)

        guard let previewURL = URL(string: "domd://local/preview.html") else {
            throw NSError(domain: "DOMDPreview", code: 1)
        }

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.loadContinuation = cont
            let nav = self.webView.load(URLRequest(url: previewURL))
            NSLog("[DOMDPreview] load called, nav=%@", nav == nil ? "nil" : "non-nil")
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        NSLog("[DOMDPreview] didStartProvisional")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        NSLog("[DOMDPreview] didCommit")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("[DOMDPreview] webContentProcessTerminated")
        resumeLoad(with: NSError(domain: "DOMDPreview", code: 2, userInfo: [NSLocalizedDescriptionKey: "web content process terminated"]))
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("[DOMDPreview] didFinish")
        resumeLoad(with: nil)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[DOMDPreview] didFail: %@", error.localizedDescription)
        resumeLoad(with: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[DOMDPreview] didFailProvisional: %@", error.localizedDescription)
        resumeLoad(with: error)
    }

    private func resumeLoad(with error: Error?) {
        guard let cont = loadContinuation else { return }
        loadContinuation = nil
        if let error = error {
            cont.resume(throwing: error)
        } else {
            cont.resume()
        }
    }

    // MARK: - Helpers

    private static func webResourceURL() -> URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let webDir = resources.appendingPathComponent("web", isDirectory: true)
        return FileManager.default.fileExists(atPath: webDir.path) ? webDir : nil
    }

    private static func readMarkdown(from url: URL) throws -> String {
        if let utf8 = try? String(contentsOf: url, encoding: .utf8) {
            return utf8
        }
        let data = try Data(contentsOf: url)
        if let s = String(data: data, encoding: .utf8) { return s }
        if let s = String(data: data, encoding: .utf16) { return s }
        if let s = String(data: data, encoding: .isoLatin1) { return s }
        return ""
    }

    private static func jsStringLiteral(_ s: String) -> String {
        if let data = try? JSONEncoder().encode(s),
           let literal = String(data: data, encoding: .utf8) {
            return literal
        }
        return "\"\""
    }
}

// MARK: - URL scheme handler

final class PreviewURLSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        let fileURL: URL
        let logKey: String
        // domd://file/<absolute-path> → read user filesystem (image referenced
        // by markdown). Sandbox entitlements gate which paths actually open.
        if url.host == "file" {
            fileURL = URL(fileURLWithPath: url.path)
            logKey = "file:\(url.path)"
        } else {
            // domd://local/<relative-path> → bundle resources (preview.html etc.)
            var relative = url.path
            if relative.hasPrefix("/") { relative.removeFirst() }
            if relative.isEmpty { relative = "preview.html" }
            fileURL = root.appendingPathComponent(relative)
            logKey = relative
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            NSLog("[DOMDPreview] scheme 404: %@", fileURL.path)
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        NSLog("[DOMDPreview] scheme 200: %@ (%d bytes)", logKey, data.count)

        let mime = Self.mimeType(for: fileURL.pathExtension)
        let headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(data.count)",
            "Access-Control-Allow-Origin": "*",
        ]
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!

        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
