// QuietNote's bridge to Apple Intelligence: Apple's model on this Mac (`SystemLanguageModel`), nothing
// in the cloud. One JSON request per line on stdin, one JSON answer per line on stdout, until stdin closes:
//   {"op":"status"} → {"built", "available", "reason"?, "contextSize"}
//   {"op":"respond", "instructions", "prompt", "schema" (JSON Schema), "maxTokens"} → {"ok":true, "json"} or
//   {"ok":false, "error": tooLong | guardrail | refusal | language | busy | assets | other, "message", "tokens"?}
// Built by build.rs for macOS 14.2 and later with FoundationModels weakly linked, so it starts everywhere
// and says when the model can't run.
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

@main
struct Helper {
    static func main() async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                reply(failure("other", "The request couldn’t be read."))
                continue
            }
            switch request["op"] as? String {
            case "status": reply(status())
            case "respond": reply(await respond(request))
            default: reply(failure("other", "Unknown request."))
            }
        }
    }
}

func reply(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}
func failure(_ error: String, _ message: String, tokens: Int? = nil) -> [String: Any] {
    var out: [String: Any] = ["ok": false, "error": error, "message": message]
    if let tokens { out["tokens"] = tokens }
    return out
}

#if canImport(FoundationModels)
func status() -> [String: Any] {
    guard #available(macOS 26.0, *) else { return ["built": true, "available": false, "reason": "osTooOld", "contextSize": 0] }
    let model = SystemLanguageModel.default
    switch model.availability {
    case .available: return ["built": true, "available": true, "contextSize": model.contextSize]
    case .unavailable(let reason):
        let name = switch reason {
        case .deviceNotEligible: "deviceNotEligible"
        case .appleIntelligenceNotEnabled: "appleIntelligenceNotEnabled"
        case .modelNotReady: "modelNotReady"
        @unknown default: "unknown"
        }
        return ["built": true, "available": false, "reason": name, "contextSize": model.contextSize]
    }
}

func respond(_ request: [String: Any]) async -> [String: Any] {
    guard #available(macOS 26.0, *) else { return failure("other", "Apple Intelligence needs macOS 26 or later.") }
    return await generate(request)
}

@available(macOS 26.0, *)
func generate(_ request: [String: Any]) async -> [String: Any] {
    let instructions = request["instructions"] as? String ?? ""
    let prompt = request["prompt"] as? String ?? ""
    let maxTokens = request["maxTokens"] as? Int
    let schema: GenerationSchema
    do { schema = try GenerationSchema(root: dynamic(request["schema"] as? [String: Any] ?? [:], "Answer"), dependencies: []) }
    catch { return failure("other", "The answer’s format couldn’t be set up: \(error)") }
    let model = SystemLanguageModel.default
    // Counting first saves generating an answer that can't fit.
    if #available(macOS 26.4, *), let used = try? await model.tokenCount(for: instructions + "\n\n" + prompt), used + (maxTokens ?? 0) > model.contextSize {
        return failure("tooLong", "This part is too long for Apple Intelligence.", tokens: used)
    }
    let session = LanguageModelSession(model: model, instructions: instructions)
    #if compiler(>=6.4)
    let options = GenerationOptions(samplingMode: .greedy, maximumResponseTokens: maxTokens)
    #else
    let options = GenerationOptions(sampling: .greedy, maximumResponseTokens: maxTokens)
    #endif
    do {
        let response = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: false, options: options)
        return ["ok": true, "json": response.content.jsonString]
    } catch let error as LanguageModelSession.GenerationError {
        switch error {
        case .exceededContextWindowSize: return failure("tooLong", "This part is too long for Apple Intelligence.")
        case .guardrailViolation: return failure("guardrail", "Apple Intelligence declined part of this meeting.")
        case .refusal: return failure("refusal", "Apple Intelligence declined to answer.")
        case .unsupportedLanguageOrLocale: return failure("language", "Apple Intelligence doesn’t support this meeting’s language.")
        case .rateLimited, .concurrentRequests: return failure("busy", "Apple Intelligence is busy. Try again in a moment.")
        case .assetsUnavailable: return failure("assets", "Apple Intelligence is still getting ready on this Mac. Try again later.")
        // Usually an answer cut off at `maxTokens`: asking about less helps.
        case .decodingFailure: return failure("tooLong", "The answer didn’t fit.")
        default: return failure("other", error.localizedDescription)
        }
    } catch {
        return failure("other", error.localizedDescription)
    }
}

/// The JSON Schema subset QuietNote sends (object, array, string with or without enum, boolean, integer), as
/// FoundationModels' schema. Properties keep the order of `required`, which is the order they're generated in.
@available(macOS 26.0, *)
func dynamic(_ node: [String: Any], _ name: String) throws -> DynamicGenerationSchema {
    let description = node["description"] as? String
    switch node["type"] as? String {
    case "object":
        let properties = node["properties"] as? [String: Any] ?? [:]
        let required = node["required"] as? [String] ?? []
        let order = required + properties.keys.filter { !required.contains($0) }.sorted()
        return DynamicGenerationSchema(name: name, description: description, properties: try order.compactMap { key in
            guard let child = properties[key] as? [String: Any] else { return nil }
            return .init(name: key, description: child["description"] as? String, schema: try dynamic(child, "\(name)_\(key)"), isOptional: !required.contains(key))
        })
    case "array":
        return DynamicGenerationSchema(arrayOf: try dynamic(node["items"] as? [String: Any] ?? [:], "\(name)_item"), maximumElements: node["maxItems"] as? Int)
    case "string":
        if let choices = node["enum"] as? [String] { return DynamicGenerationSchema(name: name, description: description, anyOf: choices) }
        return DynamicGenerationSchema(type: String.self)
    case "boolean": return DynamicGenerationSchema(type: Bool.self)
    case "integer": return DynamicGenerationSchema(type: Int.self)
    default: throw SchemaError(path: name)
    }
}
struct SchemaError: Error, CustomStringConvertible { let path: String; var description: String { "unsupported type at \(path)" } }
#else
func status() -> [String: Any] { ["built": false, "available": false, "reason": "notBuilt", "contextSize": 0] }
func respond(_ request: [String: Any]) async -> [String: Any] { failure("other", "This copy of QuietNote was built without Apple Intelligence.") }
#endif
