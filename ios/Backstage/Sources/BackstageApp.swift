import SwiftUI

@main struct BackstageApp: App {
    @StateObject private var client = Client()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            ZStack {
                if client.signedIn {
                    TabView {
                        DayView().tabItem { Label("Bookings", systemImage: "calendar") }
                        CustomerView().tabItem { Label("Customers", systemImage: "person.2") }
                        SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
                    }
                } else { Login() }
                if phase != .active { Color(.systemBackground).overlay { Text("ALL STAR BACKSTAGE").font(.headline) }.ignoresSafeArea() }
            }.environmentObject(client).tint(.red)
                .environment(\.timeZone, TimeZone(identifier: "Europe/Amsterdam")!)
        }
    }
}
struct SettingsView: View {
    @EnvironmentObject var client: Client
    var body: some View {
        NavigationStack {
            Form {
                Section("Environment") {
                    Label("Test database · Stripe sandbox", systemImage: "testtube.2")
                    Text(Client.base.host!).font(.caption).textSelection(.enabled)
                    Text("Times use Europe/Amsterdam. Payments recorded against appointment dates are not profit or daily takings.")
                }
                Button("Sign out", role: .destructive) { Task { await client.signOut() } }
            }.navigationTitle("Settings")
        }
    }
}
