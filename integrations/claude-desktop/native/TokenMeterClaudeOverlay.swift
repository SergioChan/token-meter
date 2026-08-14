import AppKit
import ApplicationServices
import Foundation
import WebKit

private let claudeBundleID = "com.anthropic.claudefordesktop"
private let defaultClaudeAppPath = "/Applications/Claude.app"
private let fileManager = FileManager.default

private func accessibilityTrusted() -> Bool {
    if ProcessInfo.processInfo.environment["TOKEN_METER_FORCE_ACCESSIBILITY_DENIED"] == "1" {
        return false
    }
    return AXIsProcessTrusted()
}

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

// Writes the LaunchAgent for a self-contained bundle launch and loads it.
// The freshly bootstrapped agent instance takes over; callers keep running
// only for this session (KeepAlive restarts us on quit or next login).
private func selfInstallLaunchAgent(rootPath: String, nodePath: String, statePath: String) throws {
    let label = "com.sergiochan.token-meter.claude-desktop"
    let executable = Bundle.main.executablePath ?? CommandLine.arguments[0]
    let logDir = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Token Meter/Claude Desktop").path
    try fileManager.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    try fileManager.createDirectory(atPath: statePath, withIntermediateDirectories: true)
    let agentsDir = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents")
    try fileManager.createDirectory(at: agentsDir, withIntermediateDirectories: true)
    let plistURL = agentsDir.appendingPathComponent("\(label).plist")
    let plist: [String: Any] = [
        "Label": label,
        "ProgramArguments": [executable, "--root", rootPath, "--node", nodePath],
        "RunAtLoad": true,
        "KeepAlive": true,
        "StandardOutPath": "\(logDir)/overlay.log",
        "StandardErrorPath": "\(logDir)/overlay-error.log",
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: plistURL, options: .atomic)
    let domain = "gui/\(getuid())"
    let boot = Process()
    boot.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    boot.arguments = ["bootout", "\(domain)/\(label)"]
    try? boot.run(); boot.waitUntilExit()
    let load = Process()
    load.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    load.arguments = ["bootstrap", domain, plistURL.path]
    try? load.run(); load.waitUntilExit()
}

private func parseCommand(_ arguments: [String]) throws -> AppCommand {
    var rootPath: String?
    var nodePath: String?
    var claudeAppPath = defaultClaudeAppPath
    var statePath = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Token Meter/State/Claude Desktop")
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
    // Self-contained bundle: launched with no arguments (double-click from
    // /Applications), resolve payload and Node from our own Resources and
    // register the LaunchAgent so the meter survives login.
    if rootPath == nil, nodePath == nil,
       let resources = Bundle.main.resourceURL {
        let bundledRoot = resources.appendingPathComponent("root")
        let bundledNode = resources.appendingPathComponent("node/bin/node")
        if fileManager.fileExists(atPath: bundledRoot.appendingPathComponent("src/cli.mjs").path),
           fileManager.isExecutableFile(atPath: bundledNode.path) {
            rootPath = bundledRoot.path
            nodePath = bundledNode.path
            try selfInstallLaunchAgent(rootPath: bundledRoot.path, nodePath: bundledNode.path, statePath: statePath)
            // The LaunchAgent instance owns the overlay from here; this
            // double-clicked process exits so two meters never run at once.
            exit(0)
        }
    }
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
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private struct SnapshotBridgeError: Error, CustomStringConvertible {
    let description: String
}

private final class RuntimeHealth {
    private let url: URL
    private let pid = ProcessInfo.processInfo.processIdentifier
    private var accessibilityChecked = false
    private var accessibilityGranted = false
    private var overlayReady = false
    private var bridgeHealthy = false
    private var sessionBound = false

    init(stateDirectoryURL: URL) throws {
        url = stateDirectoryURL.appendingPathComponent("health.json")
        try write()
    }

    func update(
        accessibilityGranted: Bool? = nil,
        overlayReady: Bool? = nil,
        bridgeHealthy: Bool? = nil,
        sessionBound: Bool? = nil
    ) {
        if let accessibilityGranted {
            self.accessibilityGranted = accessibilityGranted
            accessibilityChecked = true
        }
        if let overlayReady { self.overlayReady = overlayReady }
        if let bridgeHealthy { self.bridgeHealthy = bridgeHealthy }
        if let sessionBound { self.sessionBound = sessionBound }
        try? write()
    }

    func heartbeat() {
        try? write()
    }

    private func write() throws {
        let value: [String: Any] = [
            "schemaVersion": 1,
            "pid": pid,
            "updatedAt": ISO8601DateFormatter().string(from: Date()),
            "accessibilityChecked": accessibilityChecked,
            "accessibilityGranted": accessibilityGranted,
            "overlayReady": overlayReady,
            "bridgeHealthy": bridgeHealthy,
            "sessionBound": sessionBound,
        ]
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    deinit {
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (value["pid"] as? NSNumber)?.int32Value == pid else { return }
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

    func command(_ body: [String: Any], completion: @escaping Completion) {
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
            var payload = body
            payload["requestId"] = requestID
            let data = try JSONSerialization.data(withJSONObject: payload)
            pending[requestID] = completion
            var line = data
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
                } else if response["ok"] as? Bool == true {
                    completion(.success(response))
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
    private let health: RuntimeHealth
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
    private var contextScanCadence = ClaudeContextScanCadence(interval: 5)
    private var visibleContextWindowTokens: Int?
    private var defaultPanelOrigin = CGPoint.zero
    private var userOffset = CGPoint.zero
    private var dragTimer: Timer?
    private var dragStartMouse = CGPoint.zero
    private var dragStartPanel = CGPoint.zero
    private var dragging = false
    private var collapsed = false
    private var lastHostPosition: CGPoint?
    private var lastHostSize: CGSize?

    init(configuration: AppConfiguration, health: RuntimeHealth) {
        self.configuration = configuration
        self.health = health
        snapshotBridge = SnapshotBridge(configuration: configuration)
        contextWindowResolver = ClaudeContextWindowResolver(
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
        webView.configuration.userContentController.add(self, name: "tokenMeterAction")
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

    func stop() {
        timer?.invalidate()
        timer = nil
        dragTimer?.invalidate()
        dragTimer = nil
        snapshotBridge.stop()
        panel.orderOut(nil)
        currentSessionID = nil
        health.update(overlayReady: false, bridgeHealthy: false, sessionBound: false)
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
                self?.health.update(overlayReady: true)
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
            health.update(sessionBound: false)
            return
        }

        let appElement = AXUIElementCreateApplication(claude.processIdentifier)
        guard claude.isActive,
              let window = axElement(appElement, kAXFocusedWindowAttribute),
              let position = axPoint(window, kAXPositionAttribute),
              let size = axSize(window, kAXSizeAttribute) else {
            panel.orderOut(nil)
            health.update(sessionBound: false)
            return
        }

        guard let surface = resolveClaudeCodeSurface(in: window) else {
            panel.orderOut(nil)
            currentSessionID = nil
            visibleContextWindowTokens = nil
            health.update(bridgeHealthy: false, sessionBound: false)
            publishUnbound()
            return
        }
        let identifier = surface.sessionID

        positionPanel(hostPosition: position, hostSize: size)
        panel.orderFrontRegardless()

        if identifier != currentSessionID {
            currentSessionID = identifier
            lastSnapshotAt = .distantPast
            contextScanCadence.reset()
            visibleContextWindowTokens = nil
            publishUnbound()
        }
        let now = Date()
        if contextScanCadence.shouldScan(at: now) {
            visibleContextWindowTokens = scanExactContextWindowTokens(
                in: surface.webArea
            )
        }
        if now.timeIntervalSince(lastSnapshotAt) >= 0.8 {
            fetchSnapshot(
                for: identifier,
                contextWindowTokens: visibleContextWindowTokens
            )
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
                self.health.update(bridgeHealthy: false, sessionBound: false)
                self.publishUnbound()
                if case .failure(let error) = result {
                    fputs("Snapshot bridge failed: \(error)\n", stderr)
                }
                return
            }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                let model = (snapshot["binding"] as? [String: Any])?["model"] as? String
                let resolvedWindowTokens = contextWindowTokens ??
                    self.contextWindowResolver.resolve(model: model)
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
                        self.health.update(bridgeHealthy: true, sessionBound: true)
                        self.webView.evaluateJavaScript(
                            "window.__tokenMeter?.update(\(json))"
                        )
                    }
                } catch {
                    DispatchQueue.main.async { [weak self] in
                        self?.snapshotInFlight = false
                        self?.health.update(bridgeHealthy: false, sessionBound: false)
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
                  if (event.button !== 0 || event.target.closest('.collapse-toggle, .settings-toggle, .session-id')) return;
                  event.preventDefault();
                  event.stopPropagation();
                  window.webkit.messageHandlers.tokenMeterDrag.postMessage('start');
                });
                target.addEventListener('click', (event) => {
                  if (!event.target.closest('.collapse-toggle, .settings-toggle, .session-id')) event.stopPropagation();
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
        } else if message.name == "tokenMeterAction",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String {
            handleAction(type: type, body: body)
        }
    }

    // The web layer sends action names only. The bridge creates all URLs from
    // trusted local configuration and a signed one-time pairing request.
    private func handleAction(type: String, body: [String: Any]) {
        switch type {
        case "open-dashboard":
            // The dashboard is served by the bridge's loopback server so the
            // page can read the profile and claim a handle. Only a loopback
            // URL returned by our own bridge is ever opened. The optional
            // view ("share" / "withdraw") selects the consent wizard page.
            var command: [String: Any] = ["command": "dashboard-url"]
            if let view = body["view"] as? String, view == "share" || view == "withdraw" {
                command["view"] = view
            }
            snapshotBridge.command(command) { result in
                guard case .success(let payload) = result,
                      let urlString = payload["url"] as? String,
                      let url = URL(string: urlString),
                      url.scheme == "http",
                      url.host == "127.0.0.1" else { return }
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            }
        case "open-leaderboard":
            snapshotBridge.command(["command": "leaderboard-url"]) { result in
                guard case .success(let payload) = result,
                      payload["ok"] as? Bool == true,
                      let urlString = payload["url"] as? String,
                      let url = URL(string: urlString),
                      url.scheme == "https",
                      url.host == "www.tokenwidget.app",
                      url.path == "/leaderboard",
                      url.query == nil,
                      url.fragment?.hasPrefix("pair=") == true else { return }
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            }
        case "copy-text":
            guard let text = body["text"] as? String, text.count <= 500 else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        case "quit-widget":
            let bootout = Process()
            bootout.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            bootout.arguments = ["bootout", "gui/\(getuid())/com.sergiochan.token-meter.claude-desktop"]
            try? bootout.run()
            bootout.waitUntilExit()
            exit(0)
        case "set-sharing":
            let enabled = body["enabled"] as? Bool ?? false
            snapshotBridge.command(["command": "set-sharing", "enabled": enabled]) { _ in }
        case "dismiss-handle-prompt":
            snapshotBridge.command(["command": "dismiss-handle-prompt"]) { _ in }
        case "open-update":
            // The web layer never supplies the URL; the bridge derives it from
            // its baked-in registry endpoint.
            snapshotBridge.command(["command": "update-info"]) { result in
                guard case .success(let payload) = result,
                      payload["ok"] as? Bool == true,
                      let urlString = payload["url"] as? String,
                      let url = URL(string: urlString),
                      url.scheme == "https" || (url.scheme == "http" && url.host == "127.0.0.1"),
                      let version = payload["version"] as? String,
                      version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil
                else { return }
                self.downloadAndOpenUpdate(url: url, version: version)
            }
        default:
            break
        }
    }

    // Downloads the release DMG into ~/Downloads and opens it once Gatekeeper's
    // assessment passes, landing the user directly on the drag-to-install window.
    private func downloadAndOpenUpdate(url: URL, version: String) {
        let task = URLSession.shared.downloadTask(with: url) { temporary, _, error in
            guard error == nil, let temporary else { return }
            let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
            let destination = downloads.appendingPathComponent("TokenWidget-\(version).dmg")
            do {
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: temporary, to: destination)
            } catch {
                return
            }
            // Refuse to open anything that is not a notarized Developer ID disk
            // image; a compromised download source must not reach the user.
            let assess = Process()
            assess.executableURL = URL(fileURLWithPath: "/usr/sbin/spctl")
            assess.arguments = ["--assess", "--type", "install", destination.path]
            assess.standardOutput = FileHandle.nullDevice
            assess.standardError = FileHandle.nullDevice
            do {
                try assess.run()
                assess.waitUntilExit()
            } catch {
                return
            }
            guard assess.terminationStatus == 0 else {
                try? FileManager.default.removeItem(at: destination)
                return
            }
            DispatchQueue.main.async { NSWorkspace.shared.open(destination) }
        }
        task.resume()
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
    private let health: RuntimeHealth
    private var meterController: MeterController?

    init(configuration: AppConfiguration) throws {
        self.configuration = configuration
        health = try RuntimeHealth(stateDirectoryURL: configuration.stateDirectoryURL)
    }

    func start() {
        reconcileAccessibility(logWaiting: true)
        permissionTimer = Timer.scheduledTimer(
            withTimeInterval: 2,
            repeats: true
        ) { [weak self] _ in
            self?.reconcileAccessibility()
        }
    }

    private func reconcileAccessibility(logWaiting: Bool = false) {
        let trusted = accessibilityTrusted()
        health.update(accessibilityGranted: trusted)
        health.heartbeat()
        if !trusted {
            if let controller = meterController {
                controller.stop()
                meterController = nil
            }
            if logWaiting {
                fputs(
                    "Accessibility permission is required. Waiting quietly for permission.\n",
                    stderr
                )
            }
            return
        }
        guard meterController == nil else { return }
        let controller = MeterController(configuration: configuration, health: health)
        meterController = controller
        controller.start()
    }
}

@main
struct TokenMeterClaudeOverlayApplication {
static func main() {
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
        let runtime = try CompanionRuntime(configuration: configuration)
        runtime.start()
        withExtendedLifetime(runtime) {
            application.run()
        }
    }
} catch {
    fputs("\(error)\n\n\(usage())\n", stderr)
    exit(2)
}
}
}
