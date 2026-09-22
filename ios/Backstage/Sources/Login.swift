import SwiftUI
import WebKit

struct Login: View {
    @EnvironmentObject var client: Client
    @State private var checking = false
    @State private var message: String?
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Text("ALL STAR · BACKSTAGE").font(.headline)
                Text("Test environment").font(.caption).foregroundStyle(.secondary)
                LoginBrowser(store: client.websiteData)
                if let message { Text(message).foregroundStyle(.red).padding(.horizontal) }
                Button(checking ? "Checking…" : "Continue after signing in") {
                    checking = true
                    Task {
                        do { try await client.validateLogin() }
                        catch { message = error.localizedDescription }
                        checking = false
                    }
                }.buttonStyle(.borderedProminent).disabled(checking).padding(.bottom)
            }.navigationTitle("Staff sign-in").navigationBarTitleDisplayMode(.inline)
        }
    }
}
struct LoginBrowser: UIViewRepresentable {
    let store: WKWebsiteDataStore
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        let view = WKWebView(frame: .zero, configuration: config)
        view.load(URLRequest(url: Client.base.appendingPathComponent("admin/bookings")))
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
