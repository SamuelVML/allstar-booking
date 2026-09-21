import SwiftUI

struct CustomerView: View {
    @EnvironmentObject var client: Client
    @State private var search = ""
    @State private var customers: [Customer] = []
    @State private var message: String?
    @State private var loading = false
    var body: some View {
        NavigationStack {
            List {
                if loading { ProgressView() }
                if let message { Text(message).foregroundStyle(.red) }
                ForEach(customers) { customer in
                    NavigationLink {
                        CustomerDetail(customer: customer)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(customer.name).font(.headline)
                            Text("\(customer.completed_visits) completed visits · \(customer.loyalty_points) points").font(.caption)
                        }
                    }
                }
                if !loading && customers.isEmpty && message == nil { Text("No matching customer accounts.") }
                Text("Up to 100 matches. Search by name or email.").font(.caption).foregroundStyle(.secondary)
            }.navigationTitle("Customers").searchable(text: $search)
                .task(id: search) {
                    loading = true
                    do {
                        try await Task.sleep(for: .milliseconds(250))
                        let result: Customers = try await client.request("api/admin/customers", query: [.init(name: "q", value: search)])
                        guard !Task.isCancelled else { return }
                        customers = result.customers; message = nil
                    } catch { if Task.isCancelled { return }; customers = []; message = error.localizedDescription }
                    loading = false
                }
        }
    }
}
struct CustomerDetail: View {
    let customer: Customer
    @EnvironmentObject var client: Client
    @State private var visits: [Visit] = []
    @State private var message: String?
    var body: some View {
        List {
            Section("Customer") {
                Text(customer.email).textSelection(.enabled)
                Text(customer.phone).textSelection(.enabled)
                LabeledContent("Loyalty points", value: String(customer.loyalty_points))
                LabeledContent("Completed visits", value: String(customer.completed_visits))
            }
            Section("Latest 100 bookings") {
                if let message { Text(message).foregroundStyle(.red) }
                ForEach(visits) { visit in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(visit.appointment_date) · \(visit.start_time)").font(.headline)
                        Text("\(visit.service_name) · \(money(visit.price_cents))")
                        Text("\(visit.status) · \(visit.payment_status)".replacingOccurrences(of: "_", with: " ")).font(.caption)
                    }
                }
            }
        }.navigationTitle(customer.name).task {
            do { let result: Visits = try await client.request("api/admin/customers", query: [.init(name: "id", value: customer.id)]); visits = result.visits }
            catch { message = error.localizedDescription }
        }
    }
}
