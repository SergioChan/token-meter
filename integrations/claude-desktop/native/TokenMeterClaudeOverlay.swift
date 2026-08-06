import AppKit
import ApplicationServices
import Foundation
import WebKit

private let claudeBundleID = "com.anthropic.claudefordesktop"
private let defaultClaudeAppPath = "/Applications/Claude.app"
private let fileManager = FileManager.default

private struct CommandError: Error, CustomStringConvertible {
    let description: String
}

private struct AppConfiguration {
    let rootURL: URL
    let nodeURL: URL
    let claudeAppURL: URL
    let stateDirectoryURL: URL
    let sessionsDirectoryURL: URL
    let projectsDirectoryURL: URL

    var modelCatalogURL: URL {
        claudeAppURL.appendingPathComponent("Contents/Resources/app.asar")
    }
}

private enum AppCommand {
    case run(AppConfiguration)
    case help
    case checkAccessibility(prompt: Bool)
}

private func usage() -> String {
    """
    Usage: TokenMeterClaudeOverlay --root PATH --node PATH [options]

    Required for normal operation:
      --root PATH           Installed Token Meter runtime root
      --node PATH           Absolute path to a Node.js executable

    Options:
      --claude-app PATH     Claude.app path (default: /Applications/Claude.app)
      --state-dir PATH      Persistent overlay state directory
      --sessions-dir PATH   Claude Desktop Session metadata directory
      --projects-dir PATH   Claude Code transcript projects directory
      --check-accessibility Exit 0 when Accessibility permission is granted
      --prompt-accessibility Request Accessibility permission, then exit
      --help                Show this help
    """
}

private func absoluteURL(_ value: String, option: String) throws -> URL {
    guard value.hasPrefix("/"), !value.contains("\0"), !value.contains("\n") else {
        throw CommandError(description: "\(option) must be an absolute path")
    }
    return URL(fileURLWithPath: value).standardizedFileURL
}

private func parseCommand(_ arguments: [String]) throws -> AppCommand {
    var rootPath: String?
    var nodePath: String?
    var claudeAppPath = defaultClaudeAppPath
    var statePath = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Token Meter/claude-desktop/state")
        .path
    var sessionsPath = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Claude/claude-code-sessions")
        .path
    var projectsPath = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/projects")
        .path
    var mode: AppCommand?
    var index = 0

    func nextValue(for option: String) throws -> String {
        index += 1
        guard index < arguments.count else {
            throw CommandError(description: "Missing value for \(option)")
        }
        return arguments[index]
    }

    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--root":
            rootPath = try nextValue(for: argument)
        case "--node":
            nodePath = try nextValue(for: argument)
        case "--claude-app":
            claudeAppPath = try nextValue(for: argument)
        case "--state-dir":
            statePath = try nextValue(for: argument)
        case "--sessions-dir":
            sessionsPath = try nextValue(for: argument)
        case "--projects-dir":
            projectsPath = try nextValue(for: argument)
        case "--check-accessibility":
            mode = .checkAccessibility(prompt: false)
        case "--prompt-accessibility":
            mode = .checkAccessibility(prompt: true)
        case "--help", "-h":
            mode = .help
        default:
            throw CommandError(description: "Unknown argument: \(argument)")
        }
        index += 1
    }

    if let mode { return mode }
    guard let rootPath else {
        throw CommandError(description: "--root is required")
    }
    guard let nodePath else {
        throw CommandError(description: "--node is required")
    }
    let configuration = AppConfiguration(
        rootURL: try absoluteURL(rootPath, option: "--root"),
        nodeURL: try absoluteURL(nodePath, option: "--node"),
        claudeAppURL: try absoluteURL(claudeAppPath, option: "--claude-app"),
        stateDirectoryURL: try absoluteURL(statePath, option: "--state-dir"),
        sessionsDirectoryURL: try absoluteURL(sessionsPath, option: "--sessions-dir"),
        projectsDirectoryURL: try absoluteURL(projectsPath, option: "--projects-dir")
    )
    let requiredFiles = [
        configuration.rootURL.appendingPathComponent("src/cli.mjs"),
        configuration.rootURL.appendingPathComponent("runtime/token-meter-ui.js"),
        configuration.rootURL.appendingPathComponent("runtime/token-meter-ui.css"),
        configuration.rootURL.appendingPathComponent(
            "integrations/claude-desktop/src/overlay-bridge.mjs"
        ),
        configuration.modelCatalogURL,
    ]
    for fileURL in requiredFiles where !fileManager.fileExists(atPath: fileURL.path) {
        throw CommandError(description: "Required file is missing: \(fileURL.path)")
    }
    guard fileManager.isExecutableFile(atPath: configuration.nodeURL.path) else {
        throw CommandError(description: "Node.js is not executable: \(configuration.nodeURL.path)")
    }
    try fileManager.createDirectory(
        at: configuration.stateDirectoryURL,
        withIntermediateDirectories: true
    )
    return .run(configuration)
}
private let sessionPattern = try! NSRegularExpression(
    pattern: #"local_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"#
)
private let contextRatioPattern = try! NSRegularExpression(
    pattern: #"([0-9]+(?:\.[0-9]+)?\s*[kKmMbB]?)\s*/\s*([0-9]+(?:\.[0-9]+)?\s*[kKmMbB])"#
)

private func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return nil
    }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func axElements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    axAttribute(element, name) as? [AXUIElement] ?? []
}

private func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = axAttribute(element, name) else { return nil }
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    return nil
}

private func axPoint(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) ? size : nil
}

private func sessionID(in value: String) -> String? {
    guard let url = URL(string: value), url.host == "claude.ai" else { return nil }
    guard url.path.contains("/epitaxy/") || url.path.contains("/code/") else { return nil }
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    guard let match = sessionPattern.firstMatch(in: value, range: range),
          let swiftRange = Range(match.range, in: value) else { return nil }
    return String(value[swiftRange]).lowercased()
}

private func tokenCount(_ value: String) -> Int? {
    let normalized = value.lowercased().replacingOccurrences(of: " ", with: "")
    let multiplier: Double
    let number: String
    if normalized.hasSuffix("k") {
        multiplier = 1_000
        number = String(normalized.dropLast())
    } else if normalized.hasSuffix("m") {
        multiplier = 1_000_000
        number = String(normalized.dropLast())
    } else if normalized.hasSuffix("b") {
        multiplier = 1_000_000_000
        number = String(normalized.dropLast())
    } else {
        multiplier = 1
        number = normalized
    }
    guard let parsed = Double(number), parsed >= 0 else { return nil }
    return Int((parsed * multiplier).rounded())
}

private final class ClaudeContextWindowResolver {
    private let sessionsDirectoryURL: URL
    private let modelCatalogURL: URL
    private var windowsBySessionID: [String: Int] = [:]
    private var failedAtBySessionID: [String: Date] = [:]
    private var catalogSource: String?

    init(sessionsDirectoryURL: URL, modelCatalogURL: URL) {
        self.sessionsDirectoryURL = sessionsDirectoryURL
        self.modelCatalogURL = modelCatalogURL
    }

    func resolve(sessionID: String) -> Int? {
        if let cached = windowsBySessionID[sessionID] { return cached }
        if let failedAt = failedAtBySessionID[sessionID],
           Date().timeIntervalSince(failedAt) < 10 {
            return nil
        }
        guard let model = modelForSession(sessionID),
              let windowTokens = windowTokensForModel(model) else {
            failedAtBySessionID[sessionID] = Date()
            return nil
        }
        failedAtBySessionID.removeValue(forKey: sessionID)
        windowsBySessionID[sessionID] = windowTokens
        return windowTokens
    }

    private func modelForSession(_ sessionID: String) -> String? {
        guard let enumerator = FileManager.default.enumerator(
            at: sessionsDirectoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return nil }
        let expectedName = "\(sessionID).json"
        for case let fileURL as URL in enumerator where fileURL.lastPathComponent == expectedName {
            guard let data = try? Data(contentsOf: fileURL),
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let model = value["model"] as? String,
                  !model.isEmpty else { return nil }
            return model
        }
        return nil
    }

    private func windowTokensForModel(_ model: String) -> Int? {
        if catalogSource == nil,
           let data = try? Data(contentsOf: modelCatalogURL) {
            catalogSource = String(decoding: data, as: UTF8.self)
        }
        guard let source = catalogSource else { return nil }
        let escapedModel = NSRegularExpression.escapedPattern(for: model)
        let pattern = #"id:\s*[\"']"# + escapedModel +
            #"[\"'][\s\S]{0,4096}?context:\s*\{\s*window:\s*([0-9][0-9_]*(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)"#
        guard let expression = try? NSRegularExpression(
            pattern: pattern,
            options: [.caseInsensitive]
        ) else { return nil }
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        guard let match = expression.firstMatch(in: source, range: range),
              let numberRange = Range(match.range(at: 1), in: source) else { return nil }
        let number = source[numberRange].replacingOccurrences(of: "_", with: "")
        guard let parsed = Double(number), parsed > 0, parsed <= Double(Int.max) else {
            return nil
        }
        return Int(parsed.rounded())
    }
}

private func contextWindowTokens(in value: String) -> Int? {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    guard let match = contextRatioPattern.firstMatch(in: value, range: range),
          match.numberOfRanges == 3,
          let denominatorRange = Range(match.range(at: 2), in: value) else { return nil }
    return tokenCount(String(value[denominatorRange]))
}

private struct ClaudeWindowState {
    var sessionID: String?
    var contextWindowTokens: Int?
}

private func scanClaudeState(
    _ element: AXUIElement,
    remaining: inout Int,
    state: inout ClaudeWindowState
) {
    guard remaining > 0 else { return }
    remaining -= 1

    if state.sessionID == nil,
       let url = axString(element, "AXURL"),
       let identifier = sessionID(in: url) {
        state.sessionID = identifier
    }
    if state.contextWindowTokens == nil {
        for attribute in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
            if let value = axString(element, attribute),
               let windowTokens = contextWindowTokens(in: value) {
                state.contextWindowTokens = windowTokens
                break
            }
        }
    }
    for child in axElements(element, kAXChildrenAttribute) {
        scanClaudeState(child, remaining: &remaining, state: &state)
    }
}

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private struct SnapshotBridgeError: Error, CustomStringConvertible {
    let description: String
}

private final class ReadyMarker {
    private let url: URL
    private let value: String

    init(stateDirectoryURL: URL) throws {
        url = stateDirectoryURL.appendingPathComponent("ready.pid")
        value = "\(ProcessInfo.processInfo.processIdentifier)\n"
        try value.write(to: url, atomically: true, encoding: .utf8)
    }

    deinit {
        guard (try? String(contentsOf: url, encoding: .utf8)) == value else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

private final class SnapshotBridge {
    typealias Completion = (Result<[String: Any], Error>) -> Void

    private let configuration: AppConfiguration
    private var process: Process?
    private var inputHandle: FileHandle?
    private var outputHandle: FileHandle?
    private var outputBuffer = Data()
    private var nextRequestID = 1
    private var pending: [Int: Completion] = [:]

    init(configuration: AppConfiguration) {
        self.configuration = configuration
    }

    func request(sessionID: String, completion: @escaping Completion) {
        do {
            try ensureStarted()
        } catch {
            completion(.failure(error))
            restart()
            return
        }

        let requestID = nextRequestID
        nextRequestID += 1
        do {
            let payload = try JSONSerialization.data(withJSONObject: [
                "requestId": requestID,
                "desktopSessionId": sessionID,
            ])
            pending[requestID] = completion
            var line = payload
            line.append(0x0A)
            try inputHandle?.write(contentsOf: line)
        } catch {
            pending.removeValue(forKey: requestID)?(.failure(error))
            restart()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, let timedOut = self.pending.removeValue(forKey: requestID) else {
                return
            }
            timedOut(.failure(SnapshotBridgeError(
                description: "Snapshot bridge timed out"
            )))
            self.restart()
        }
    }

    func stop() {
        outputHandle?.readabilityHandler = nil
        try? inputHandle?.close()
        inputHandle = nil
        outputHandle = nil
        if process?.isRunning == true { process?.terminate() }
        process = nil
        failPending(SnapshotBridgeError(description: "Snapshot bridge stopped"))
    }

    private func ensureStarted() throws {
        if process?.isRunning == true, inputHandle != nil { return }
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = configuration.nodeURL
        process.arguments = [
            configuration.rootURL.appendingPathComponent(
                "integrations/claude-desktop/src/overlay-bridge.mjs"
            ).path,
            "--sessions-dir",
            configuration.sessionsDirectoryURL.path,
            "--projects-dir",
            configuration.projectsDirectoryURL.path,
        ]
        process.currentDirectoryURL = configuration.rootURL
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self, weak process] _ in
            DispatchQueue.main.async {
                guard let self, let process, self.process === process else { return }
                self.outputHandle?.readabilityHandler = nil
                self.process = nil
                self.inputHandle = nil
                self.outputHandle = nil
                self.outputBuffer.removeAll(keepingCapacity: true)
                self.failPending(SnapshotBridgeError(
                    description: "Snapshot bridge exited"
                ))
            }
        }
        try process.run()
        self.process = process
        inputHandle = input.fileHandleForWriting
        outputHandle = output.fileHandleForReading
        outputHandle?.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
    }

    private func consume(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer.prefix(upTo: newline)
            outputBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            do {
                guard let response = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                      let requestID = (response["requestId"] as? NSNumber)?.intValue,
                      let completion = pending.removeValue(forKey: requestID) else {
                    continue
                }
                if let error = response["error"] as? [String: Any] {
                    completion(.failure(SnapshotBridgeError(
                        description: error["message"] as? String ?? "Snapshot bridge failed"
                    )))
                } else if let snapshot = response["snapshot"] as? [String: Any] {
                    completion(.success(snapshot))
                } else {
                    completion(.failure(SnapshotBridgeError(
                        description: "Snapshot bridge returned an invalid response"
                    )))
                }
            } catch {
                fputs("Ignoring an invalid snapshot bridge response: \(error)\n", stderr)
            }
        }
    }

    private func restart() {
        outputHandle?.readabilityHandler = nil
        try? inputHandle?.close()
        if process?.isRunning == true { process?.terminate() }
        process = nil
        inputHandle = nil
        outputHandle = nil
        outputBuffer.removeAll(keepingCapacity: true)
        failPending(SnapshotBridgeError(description: "Snapshot bridge restarted"))
    }

    private func failPending(_ error: Error) {
        let completions = pending.values
        pending.removeAll()
        for completion in completions { completion(.failure(error)) }
    }
}

private final class MeterController: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private let configuration: AppConfiguration
    private let snapshotBridge: SnapshotBridge
    private let contextWindowResolver: ClaudeContextWindowResolver
    private let expandedPanelSize = CGSize(width: 320, height: 250)
    private let collapsedPanelSize = CGSize(width: 168, height: 96)
    private var currentPanelSize = CGSize(width: 320, height: 250)
    private let panel: OverlayPanel
    private let webView: WKWebView
    private var timer: Timer?
    private var currentSessionID: String?
    private var snapshotInFlight = false
    private var pageReady = false
    private var lastSnapshotAt = Date.distantPast
    private var defaultPanelOrigin = CGPoint.zero
    private var userOffset = CGPoint.zero
    private var dragTimer: Timer?
    private var dragStartMouse = CGPoint.zero
    private var dragStartPanel = CGPoint.zero
    private var dragging = false
    private var collapsed = false
    private var lastHostPosition: CGPoint?
    private var lastHostSize: CGSize?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        snapshotBridge = SnapshotBridge(configuration: configuration)
        contextWindowResolver = ClaudeContextWindowResolver(
            sessionsDirectoryURL: configuration.sessionsDirectoryURL,
            modelCatalogURL: configuration.modelCatalogURL
        )
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.websiteDataStore = .nonPersistent()
        webView = WKWebView(
            frame: CGRect(origin: .zero, size: CGSize(width: 320, height: 250)),
            configuration: webConfiguration
        )
        panel = OverlayPanel(
            contentRect: CGRect(origin: .zero, size: CGSize(width: 320, height: 250)),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()

        panel.contentView = webView
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "tokenMeterDrag")
        webView.configuration.userContentController.add(self, name: "tokenMeterLayout")
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = .clear }
        webView.loadHTMLString(
            "<html><head><meta name=\"color-scheme\" content=\"light dark\"></head>" +
            "<body style=\"margin:0;background:transparent;overflow:hidden\"></body></html>",
            baseURL: nil
        )
        loadOffset()
        loadCollapsedState()
        resizePanel()
    }

    deinit {
        snapshotBridge.stop()
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            self?.tick()
        }
        tick()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        do {
            let css = try String(
                contentsOf: configuration.rootURL.appendingPathComponent(
                    "runtime/token-meter-ui.css"
                ),
                encoding: .utf8
            )
            var script = try String(
                contentsOf: configuration.rootURL.appendingPathComponent(
                    "runtime/token-meter-ui.js"
                ),
                encoding: .utf8
            )
            let encodedCSS = try JSONEncoder().encode(css)
            let cssJSON = String(decoding: encodedCSS, as: UTF8.self)
            script = script.replacingOccurrences(of: "__TOKEN_METER_CSS_JSON__", with: cssJSON)
            webView.evaluateJavaScript(script) { [weak self] _, error in
                guard error == nil else {
                    fputs("Failed to initialize meter UI: \(error!)\n", stderr)
                    return
                }
                self?.pageReady = true
                self?.installDragBridge()
                self?.configureMeterLayout()
                self?.publishUnbound()
            }
        } catch {
            fputs("Failed to load meter assets: \(error)\n", stderr)
        }
    }

    private func tick() {
        guard let claude = NSRunningApplication.runningApplications(
            withBundleIdentifier: claudeBundleID
        ).first else {
            panel.orderOut(nil)
            currentSessionID = nil
            return
        }

        let appElement = AXUIElementCreateApplication(claude.processIdentifier)
        guard claude.isActive,
              let window = axElement(appElement, kAXFocusedWindowAttribute),
              let position = axPoint(window, kAXPositionAttribute),
              let size = axSize(window, kAXSizeAttribute) else {
            panel.orderOut(nil)
            return
        }

        var budget = 12_000
        var state = ClaudeWindowState()
        scanClaudeState(window, remaining: &budget, state: &state)
        guard let identifier = state.sessionID else {
            panel.orderOut(nil)
            currentSessionID = nil
            publishUnbound()
            return
        }

        positionPanel(hostPosition: position, hostSize: size)
        panel.orderFrontRegardless()

        if identifier != currentSessionID {
            currentSessionID = identifier
            lastSnapshotAt = .distantPast
            publishUnbound()
        }
        if Date().timeIntervalSince(lastSnapshotAt) >= 0.8 {
            fetchSnapshot(for: identifier, contextWindowTokens: state.contextWindowTokens)
        }
    }

    private func positionPanel(hostPosition: CGPoint, hostSize: CGSize) {
        lastHostPosition = hostPosition
        lastHostSize = hostSize
        let hostCenter = CGPoint(
            x: hostPosition.x + hostSize.width / 2,
            y: hostPosition.y + hostSize.height / 2
        )
        let screenMapping = NSScreen.screens.compactMap { screen -> (NSScreen, CGRect)? in
            guard let number = screen.deviceDescription[
                NSDeviceDescriptionKey("NSScreenNumber")
            ] as? NSNumber else { return nil }
            return (screen, CGDisplayBounds(CGDirectDisplayID(number.uint32Value)))
        }.first { _, displayBounds in displayBounds.contains(hostCenter) }
        let hostAppKitOrigin: CGPoint
        if let (screen, displayBounds) = screenMapping {
            hostAppKitOrigin = CGPoint(
                x: screen.frame.minX + hostPosition.x - displayBounds.minX,
                y: screen.frame.maxY - (hostPosition.y - displayBounds.minY) - hostSize.height
            )
        } else {
            hostAppKitOrigin = CGPoint(
                x: hostPosition.x,
                y: CGDisplayBounds(CGMainDisplayID()).height - hostPosition.y - hostSize.height
            )
        }
        defaultPanelOrigin = CGPoint(
            x: hostAppKitOrigin.x + hostSize.width - currentPanelSize.width - 16,
            y: hostAppKitOrigin.y + 16
        )
        if !dragging {
            panel.setFrameOrigin(CGPoint(
                x: defaultPanelOrigin.x + userOffset.x,
                y: defaultPanelOrigin.y + userOffset.y
            ))
        }
    }

    private func fetchSnapshot(for identifier: String, contextWindowTokens: Int?) {
        guard !snapshotInFlight else { return }
        snapshotInFlight = true
        lastSnapshotAt = Date()
        snapshotBridge.request(sessionID: identifier) { [weak self] result in
            guard let self else { return }
            guard case .success(var snapshot) = result else {
                self.snapshotInFlight = false
                self.publishUnbound()
                if case .failure(let error) = result {
                    fputs("Snapshot bridge failed: \(error)\n", stderr)
                }
                return
            }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                let resolvedWindowTokens = contextWindowTokens ??
                    self.contextWindowResolver.resolve(sessionID: identifier)
                if let contextWindowTokens = resolvedWindowTokens,
                   var context = snapshot["context"] as? [String: Any] {
                    context["windowTokens"] = contextWindowTokens
                    if let tokens = context["tokens"] as? NSNumber {
                        context["percent"] = min(
                            100,
                            max(0, tokens.doubleValue / Double(contextWindowTokens) * 100)
                        )
                    }
                    snapshot["context"] = context
                }
                do {
                    let data = try JSONSerialization.data(withJSONObject: snapshot)
                    let json = String(decoding: data, as: UTF8.self)
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        self.snapshotInFlight = false
                        guard self.currentSessionID == identifier else { return }
                        self.webView.evaluateJavaScript(
                            "window.__tokenMeter?.update(\(json))"
                        )
                    }
                } catch {
                    DispatchQueue.main.async { [weak self] in
                        self?.snapshotInFlight = false
                        self?.publishUnbound()
                    }
                }
            }
        }
    }

    private func publishUnbound() {
        guard pageReady else { return }
        webView.evaluateJavaScript(
            "window.__tokenMeter?.update({status:'unbound',binding:{exact:false}})"
        )
    }

    private func installDragBridge() {
        webView.evaluateJavaScript(
            """
            (() => {
              const shadow = document.getElementById('token-meter-host')?.shadowRoot;
              const targets = [shadow?.querySelector('.meter-header'), shadow?.querySelector('.gauge')]
                .filter(Boolean);
              for (const target of targets) {
                if (target.dataset.nativeDrag === 'true') continue;
                target.dataset.nativeDrag = 'true';
                target.style.cursor = 'grab';
                target.addEventListener('mousedown', (event) => {
                  if (event.button !== 0 || event.target.closest('.collapse-toggle')) return;
                  event.preventDefault();
                  event.stopPropagation();
                  window.webkit.messageHandlers.tokenMeterDrag.postMessage('start');
                });
                target.addEventListener('click', (event) => {
                  if (!event.target.closest('.collapse-toggle')) event.stopPropagation();
                });
              }
            })();
            """
        )
    }

    private func configureMeterLayout() {
        let value = collapsed ? "true" : "false"
        webView.evaluateJavaScript(
            "window.__tokenMeter?.configure({collapsible:true,collapsed:\(value)})"
        )
    }

    private func applyCollapsed(_ value: Bool) {
        guard value != collapsed else {
            saveCollapsedState()
            return
        }
        collapsed = value
        currentPanelSize = collapsed ? collapsedPanelSize : expandedPanelSize
        resizePanel()
        if let position = lastHostPosition, let size = lastHostSize {
            positionPanel(hostPosition: position, hostSize: size)
        }
        saveCollapsedState()
    }

    private func resizePanel() {
        panel.setContentSize(currentPanelSize)
        webView.frame = CGRect(origin: .zero, size: currentPanelSize)
    }

    private func loadCollapsedState() {
        guard let data = try? Data(contentsOf: collapsedStateURL),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Bool] else {
            return
        }
        collapsed = value["collapsed"] ?? false
        currentPanelSize = collapsed ? collapsedPanelSize : expandedPanelSize
    }

    private func saveCollapsedState() {
        let value = ["collapsed": collapsed]
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        try? data.write(to: collapsedStateURL, options: .atomic)
    }

    private var collapsedStateURL: URL {
        configuration.stateDirectoryURL.appendingPathComponent("collapsed.json")
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == "tokenMeterDrag", message.body as? String == "start" {
            beginDrag()
        } else if message.name == "tokenMeterLayout",
                  let body = message.body as? [String: Any],
                  let value = body["collapsed"] as? Bool {
            applyCollapsed(value)
        }
    }

    private func beginDrag() {
        dragging = true
        dragStartMouse = NSEvent.mouseLocation
        dragStartPanel = panel.frame.origin
        dragTimer?.invalidate()
        dragTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) {
            [weak self] _ in self?.updateDrag()
        }
    }

    private func updateDrag() {
        guard dragging else { return }
        if NSEvent.pressedMouseButtons & 1 == 0 {
            finishDrag()
            return
        }
        let mouse = NSEvent.mouseLocation
        panel.setFrameOrigin(CGPoint(
            x: dragStartPanel.x + mouse.x - dragStartMouse.x,
            y: dragStartPanel.y + mouse.y - dragStartMouse.y
        ))
    }

    private func finishDrag() {
        dragging = false
        dragTimer?.invalidate()
        dragTimer = nil
        userOffset = CGPoint(
            x: panel.frame.origin.x - defaultPanelOrigin.x,
            y: panel.frame.origin.y - defaultPanelOrigin.y
        )
        saveOffset()
    }

    private var offsetURL: URL {
        configuration.stateDirectoryURL.appendingPathComponent("position.json")
    }

    private func loadOffset() {
        guard let data = try? Data(contentsOf: offsetURL),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Double] else {
            return
        }
        userOffset = CGPoint(x: value["x"] ?? 0, y: value["y"] ?? 0)
    }

    private func saveOffset() {
        let value = ["x": userOffset.x, "y": userOffset.y]
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        try? data.write(to: offsetURL, options: .atomic)
    }
}

private final class CompanionRuntime {
    private let configuration: AppConfiguration
    private var permissionTimer: Timer?
    private var readyMarker: ReadyMarker?
    private var meterController: MeterController?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
    }

    func start() {
        if startMeterIfTrusted() { return }
        fputs(
            "Accessibility permission is required. Waiting quietly for permission.\n",
            stderr
        )
        permissionTimer = Timer.scheduledTimer(
            withTimeInterval: 2,
            repeats: true
        ) { [weak self] _ in
            _ = self?.startMeterIfTrusted()
        }
    }

    @discardableResult
    private func startMeterIfTrusted() -> Bool {
        guard meterController == nil, AXIsProcessTrusted() else {
            return meterController != nil
        }
        do {
            let marker = try ReadyMarker(
                stateDirectoryURL: configuration.stateDirectoryURL
            )
            let controller = MeterController(configuration: configuration)
            readyMarker = marker
            meterController = controller
            permissionTimer?.invalidate()
            permissionTimer = nil
            controller.start()
            return true
        } catch {
            fputs("Failed to start Token Meter: \(error)\n", stderr)
            NSApplication.shared.terminate(nil)
            return false
        }
    }
}

do {
    let command = try parseCommand(Array(CommandLine.arguments.dropFirst()))
    switch command {
    case .help:
        print(usage())
    case .checkAccessibility(let prompt):
        let trusted: Bool
        if prompt {
            let options = [
                kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
            ] as CFDictionary
            trusted = AXIsProcessTrustedWithOptions(options)
        } else {
            trusted = AXIsProcessTrusted()
        }
        if trusted {
            print("Accessibility permission is granted.")
        } else {
            fputs(
                "Accessibility permission is required for exact Claude Session binding.\n",
                stderr
            )
            exit(2)
        }
    case .run(let configuration):
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let runtime = CompanionRuntime(configuration: configuration)
        runtime.start()
        withExtendedLifetime(runtime) {
            application.run()
        }
    }
} catch {
    fputs("\(error)\n\n\(usage())\n", stderr)
    exit(2)
}
