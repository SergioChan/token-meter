import ApplicationServices
import Foundation

private let localSessionPattern = try! NSRegularExpression(
    pattern: #"^local_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#
)
private let exactContextRatioPattern = try! NSRegularExpression(
    pattern: #"(?i)^\s*(?:context\s+window\s*:?\s*)?([0-9]+(?:\.[0-9]+)?\s*[kKmMbB]?)\s*/\s*([0-9]+(?:\.[0-9]+)?\s*[kKmMbB])(?:\s*\(\s*[0-9]+(?:\.[0-9]+)?%\s*\))?\s*$"#
)
private let claudeWebAreaRole = "AXWebArea"
private let claudeButtonRole = "AXButton"

struct ClaudeAXURLCandidate {
    let role: String
    let url: String
}

struct ClaudeCodeSurface {
    let sessionID: String
    let webArea: AXUIElement
}

struct ClaudeContextScanCadence {
    let interval: TimeInterval
    private var nextScanAt: Date?

    init(interval: TimeInterval) {
        precondition(interval >= 0)
        self.interval = interval
    }

    mutating func shouldScan(at now: Date) -> Bool {
        if let nextScanAt, now < nextScanAt { return false }
        nextScanAt = now.addingTimeInterval(interval)
        return true
    }

    mutating func reset() {
        nextScanAt = nil
    }
}

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return nil
    }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func axElements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    axAttribute(element, name) as? [AXUIElement] ?? []
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = axAttribute(element, name) else { return nil }
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    return nil
}

func axPoint(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) ? size : nil
}

private func exactClaudeCodeSessionID(in value: String) -> String? {
    guard let url = URL(string: value),
          url.scheme?.lowercased() == "https",
          url.host?.lowercased() == "claude.ai",
          url.user == nil,
          url.password == nil else { return nil }
    let components = url.path.split(separator: "/", omittingEmptySubsequences: true)
    guard components.count == 2,
          components[0] == "epitaxy" || components[0] == "code" else { return nil }
    let identifier = String(components[1])
    let range = NSRange(identifier.startIndex..<identifier.endIndex, in: identifier)
    guard localSessionPattern.firstMatch(in: identifier, range: range) != nil else {
        return nil
    }
    return identifier.lowercased()
}

func resolveUniqueClaudeCodeSessionID(
    from candidates: [ClaudeAXURLCandidate]
) -> String? {
    let matches = candidates.compactMap { candidate -> String? in
        guard candidate.role == claudeWebAreaRole else { return nil }
        return exactClaudeCodeSessionID(in: candidate.url)
    }
    guard matches.count == 1 else { return nil }
    return matches[0]
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

func exactContextWindowTokens(role: String, value: String) -> Int? {
    guard role == claudeButtonRole else { return nil }
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    guard let match = exactContextRatioPattern.firstMatch(in: value, range: range),
          match.numberOfRanges == 3,
          let denominatorRange = Range(match.range(at: 2), in: value) else {
        return nil
    }
    return tokenCount(String(value[denominatorRange]))
}

func resolveClaudeCodeSurface(
    in window: AXUIElement,
    maxNodes: Int = 512,
    maxDepth: Int = 8
) -> ClaudeCodeSurface? {
    var queue: [(element: AXUIElement, depth: Int)] = [(window, 0)]
    var index = 0
    var examined = 0
    var matches: [(candidate: ClaudeAXURLCandidate, element: AXUIElement)] = []

    while index < queue.count && examined < maxNodes {
        let entry = queue[index]
        index += 1
        examined += 1
        let role = axString(entry.element, kAXRoleAttribute) ?? ""
        if role == claudeWebAreaRole {
            if let url = axString(entry.element, "AXURL") {
                let candidate = ClaudeAXURLCandidate(role: role, url: url)
                if exactClaudeCodeSessionID(in: url) != nil {
                    matches.append((candidate, entry.element))
                }
            }
            continue
        }
        if entry.depth < maxDepth {
            for child in axElements(entry.element, kAXChildrenAttribute) {
                queue.append((child, entry.depth + 1))
                if queue.count > maxNodes { break }
            }
        }
    }

    let candidates = matches.map(\.candidate)
    guard let sessionID = resolveUniqueClaudeCodeSessionID(from: candidates),
          matches.count == 1 else { return nil }
    return ClaudeCodeSurface(sessionID: sessionID, webArea: matches[0].element)
}

func scanExactContextWindowTokens(
    in webArea: AXUIElement,
    maxNodes: Int = 2_000
) -> Int? {
    var queue = axElements(webArea, kAXChildrenAttribute)
    var index = 0
    var examined = 0
    while index < queue.count && examined < maxNodes {
        let element = queue[index]
        index += 1
        examined += 1
        let role = axString(element, kAXRoleAttribute) ?? ""
        if role == claudeButtonRole,
           let title = axString(element, kAXTitleAttribute),
           let tokens = exactContextWindowTokens(role: role, value: title) {
            return tokens
        }
        for child in axElements(element, kAXChildrenAttribute) {
            queue.append(child)
            if queue.count > maxNodes { break }
        }
    }
    return nil
}
