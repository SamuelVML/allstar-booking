import Foundation
import WebKit
import Combine

// The first build is deliberately pinned to the isolated test Worker.
@MainActor final class Client: ObservableObject {
    static let base = URL(string: "https://allstar-booking-test.samuel-731.workers.dev")!
    @Published var signedIn = false
    let websiteData = WKWebsiteDataStore.nonPersistent()
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 25
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }()
    func request<T: Decodable>(_ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil) async throws -> T {
        var parts = URLComponents(url: Self.base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        parts.queryItems = query.isEmpty ? nil : query
        let url = parts.url!
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let cookies = await websiteData.httpCookieStore.allCookies()
        let allowed = cookies.filter {
            $0.name == "CF_Authorization" && $0.isSecure &&
            ($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == Self.base.host!) &&
            ($0.expiresDate == nil || $0.expiresDate! > Date()) &&
            (url.path == $0.path || url.path.hasPrefix($0.path.hasSuffix("/") ? $0.path : $0.path + "/"))
        }
        for (name, value) in HTTPCookie.requestHeaderFields(with: allowed) { request.setValue(value, forHTTPHeaderField: name) }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(Self.base.absoluteString, forHTTPHeaderField: "Origin")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw failure("No server response.") }
        if [301, 302, 303, 307, 308, 401, 403].contains(http.statusCode) {
            signedIn = false
            throw failure("Your session has ended. Sign in again.")
        }
        guard (200...299).contains(http.statusCode) else {
            throw failure((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "Unable to complete the request. Refresh before retrying.")
        }
        guard http.value(forHTTPHeaderField: "Content-Type")?.contains("application/json") == true else {
            throw failure("Unexpected response. Check the backend deployment and sign in again.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func validateLogin() async throws {
        let _: Day = try await request("api/admin/bookings")
        signedIn = true
    }
    func signOut() async {
        signedIn = false
        await websiteData.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "Backstage", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
