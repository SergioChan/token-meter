import Foundation

final class ClaudeContextWindowResolver {
    private let modelCatalogURL: URL
    private var windowsByModel: [String: Int] = [:]
    private var catalogSource: String?
    private var catalogFingerprint: String?

    init(modelCatalogURL: URL) {
        self.modelCatalogURL = modelCatalogURL
    }

    func resolve(model: String?) -> Int? {
        guard let model, !model.isEmpty, model.count <= 256,
              refreshCatalogIfNeeded() else { return nil }
        if let cached = windowsByModel[model] { return cached }
        guard let tokens = windowTokensForModel(model) else { return nil }
        windowsByModel[model] = tokens
        return tokens
    }

    private func refreshCatalogIfNeeded() -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(
            atPath: modelCatalogURL.path
        ),
              let modifiedAt = attributes[.modificationDate] as? Date,
              let size = attributes[.size] as? NSNumber else { return false }
        let fingerprint = "\(modifiedAt.timeIntervalSince1970):\(size.uint64Value)"
        if catalogFingerprint != fingerprint {
            guard let data = try? Data(contentsOf: modelCatalogURL) else { return false }
            catalogSource = String(decoding: data, as: UTF8.self)
            catalogFingerprint = fingerprint
            windowsByModel.removeAll()
        }
        return catalogSource != nil
    }

    private func windowTokensForModel(_ model: String) -> Int? {
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
