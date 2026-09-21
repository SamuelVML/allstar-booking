import SwiftUI

struct DayView: View {
    @EnvironmentObject var client: Client
    @State private var date = Date()
    @State private var day: Day?
    @State private var error: String?
    @State private var loading = false
    @State private var operation: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("ALL STAR · TEST").font(.caption.bold()).foregroundStyle(.red)
                    DatePicker("Appointments", selection: $date, displayedComponents: .date)
                    Button("Today") { date = Date() }
                }
                if loading { ProgressView("Loading…") }
                if let error { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
                if let day, day.date == shopDate(date) {
                    Section("Appointment totals") {
                        LabeledContent("Booked value", value: money(day.booked))
                        LabeledContent("Recorded payments", value: money(day.paid))
                        Text("Payments against this date’s appointments, including paid cancellations. Not daily takings or profit.").font(.caption).foregroundStyle(.secondary)
                    }
                    Section("Appointments") {
                        if day.bookings.isEmpty { Text("No bookings for this date.") }
                        ForEach(day.bookings) { booking in
                            NavigationLink {
                                BookingView(booking: booking, onSaved: { await load() })
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack { Text("\(booking.start_time)–\(booking.end_time)").bold(); Spacer(); Text(money(booking.price_cents)) }
                                    Text(booking.customer_name).font(.headline)
                                    Text(booking.service_name).foregroundStyle(.secondary)
                                    Text("\(booking.status) · \(booking.payment_status)".replacingOccurrences(of: "_", with: " ")).font(.caption)
                                }.padding(.vertical, 5)
                            }
                        }
                    }
                    Section("Time off") {
                        ForEach(day.blocks) { block in
                            NavigationLink("\(block.start_time)–\(block.end_time) · \(block.reason)") {
                                RemoveBlockView(block: block, onSaved: { await load() })
                            }
                        }
                        Button("Block time off", systemImage: "calendar.badge.minus") { operation = "block" }
                        Button("Add walk-in", systemImage: "person.badge.plus") { operation = "walk_in" }
                    }
                }
            }.navigationTitle("Backstage")
                .task(id: shopDate(date)) { await load() }
                .refreshable { await load() }
                .sheet(isPresented: Binding(get: { operation != nil }, set: { if !$0 { operation = nil } })) {
                    OperationView(action: operation ?? "block", date: shopDate(date), services: day?.services ?? [], onSaved: { await load() })
                }
        }
    }
    private func load() async {
        let requested = shopDate(date)
        loading = true; error = nil
        do {
            let result: Day = try await client.request("api/admin/bookings", query: [.init(name: "date", value: requested)])
            guard !Task.isCancelled, requested == shopDate(date) else { return }
            day = result
        } catch {
            guard !Task.isCancelled, requested == shopDate(date) else { return }
            day = nil; self.error = error.localizedDescription
        }
        loading = false
    }
}
struct BookingView: View {
    let booking: Booking
    let onSaved: () async -> Void
    @EnvironmentObject var client: Client
    @Environment(\.dismiss) private var dismiss
    @State private var action = ""
    @State private var confirming = false
    @State private var busy = false
    @State private var message: String?
    @State private var saved = false
    @State private var requestID = UUID().uuidString
    var body: some View {
        Form {
            Section(booking.service_name) {
                Text(booking.customer_name).font(.title2.bold())
                Text("\(booking.appointment_date) · \(booking.start_time)–\(booking.end_time)")
                LabeledContent("Total", value: money(booking.price_cents))
                LabeledContent("Payment", value: booking.payment_status.replacingOccurrences(of: "_", with: " "))
                LabeledContent("Method", value: booking.payment_method.replacingOccurrences(of: "_", with: " "))
                Text(booking.reference).font(.caption).textSelection(.enabled)
                if !booking.notes.isEmpty { Text(booking.notes) }
                Text(booking.customer_email).textSelection(.enabled)
                Text(booking.customer_phone).textSelection(.enabled)
            }
            if let message { Text(message).foregroundStyle(.red) }
            if saved { Button("Return to bookings") { dismiss() } }
            else {
                Section("Manage") {
                    if booking.status == "confirmed" {
                        NavigationLink("Reschedule") { RescheduleView(booking: booking, onSaved: { await onSaved(); saved = true }) }
                        Button("Complete visit") { action = "complete"; confirming = true }
                        Button("Cancel booking", role: .destructive) { action = "cancel"; confirming = true }
                    }
                    if booking.canPay {
                        Button("Record cash received · \(money(booking.price_cents))") { action = "cash"; confirming = true }
                        Button("Record card payment received · \(money(booking.price_cents))") { action = "card"; confirming = true }
                    }
                    Text("Completing a visit does not record payment. Recording a payment does not charge a card. Refunds are handled separately.").font(.caption)
                }.disabled(busy)
            }
            if busy { ProgressView("Saving…") }
        }.navigationTitle("Appointment").navigationBarTitleDisplayMode(.inline)
            .confirmationDialog("Confirm \(action)?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Confirm") { Task { await save() } }
                Button("Keep unchanged", role: .cancel) {}
            } message: {
                Text(action == "cancel" && booking.payment_status == "paid" ? "This releases the slot but does not refund the payment." : "This updates the test database.")
            }
    }
    private func save() async {
        guard !busy else { return }
        busy = true; message = nil
        do {
            var payload: [String: Any] = ["reference": booking.reference, "revision": booking.revision, "action": action]
            let payment = ["cash", "card"].contains(action)
            if payment { payload["action"] = "payment"; payload["method"] = action; payload["id"] = requestID }
            let result: Saved = try await client.request(payment ? "api/admin/operations" : "api/admin/bookings/change", body: payload)
            saved = true
            await onSaved()
            if result.notificationsSent == false { message = "Booking updated, but email delivery failed. Contact the customer directly." }
            else { dismiss() }
        } catch { message = error.localizedDescription + " Return to bookings and refresh before retrying." }
        busy = false
    }
}
struct RescheduleView: View {
    let booking: Booking
    let onSaved: () async -> Void
    @EnvironmentObject var client: Client
    @Environment(\.dismiss) private var dismiss
    @State private var date = Date()
    @State private var times: [String] = []
    @State private var time = ""
    @State private var message: String?
    @State private var busy = false
    @State private var saved = false
    var body: some View {
        Form {
            DatePicker("New date", selection: $date, displayedComponents: .date).disabled(busy || saved)
            Picker("Time", selection: $time) {
                Text("Choose a time").tag("")
                ForEach(times, id: \.self) { Text($0).tag($0) }
            }.disabled(busy || saved)
            if times.isEmpty { Text("No available times loaded for this date.") }
            if let message { Text(message).foregroundStyle(.red) }
            if saved { Button("Done") { dismiss() } }
            else { Button("Confirm reschedule") { Task { await save() } }.disabled(time.isEmpty || busy) }
        }.navigationTitle("Reschedule")
            .task(id: shopDate(date)) {
                let key = shopDate(date)
                times = []; time = ""; busy = true
                do {
                    let result: Times = try await client.request("api/admin/bookings/availability", query: [.init(name: "reference", value: booking.reference), .init(name: "date", value: key)])
                    guard !Task.isCancelled, key == shopDate(date) else { return }
                    times = result.times; message = nil
                } catch { if !Task.isCancelled { message = error.localizedDescription } }
                busy = false
            }
    }
    private func save() async {
        busy = true
        do {
            let result: Saved = try await client.request("api/admin/bookings/change", body: ["action": "reschedule", "reference": booking.reference, "revision": booking.revision, "date": shopDate(date), "time": time])
            saved = true; await onSaved()
            if result.notificationsSent == false { message = "Booking moved. Email delivery failed; contact the customer directly." }
            else { dismiss() }
        } catch { message = error.localizedDescription }
        busy = false
    }
}
struct OperationView: View {
    let action: String
    let date: String
    let services: [Service]
    let onSaved: () async -> Void
    @EnvironmentObject var client: Client
    @Environment(\.dismiss) private var dismiss
    @State private var name = "Walk-in"
    @State private var start = "10:00"
    @State private var end = "10:30"
    @State private var notes = ""
    @State private var service = "haircut"
    @State private var busy = false
    @State private var message: String?
    @State private var requestID = UUID().uuidString
    var body: some View {
        NavigationStack {
            Form {
                Text(date)
                if action == "walk_in" {
                    TextField("Customer name", text: $name)
                    Picker("Service", selection: $service) {
                        ForEach(services) { Text("\($0.name) · \(money($0.priceCents))").tag($0.id) }
                    }
                }
                TextField("Start HH:mm", text: $start).keyboardType(.numbersAndPunctuation)
                if action == "block" { TextField("End HH:mm", text: $end).keyboardType(.numbersAndPunctuation) }
                TextField(action == "block" ? "Reason" : "Notes", text: $notes)
                Text("Use five-minute steps. The server checks opening hours, breaks and existing reservations.").font(.caption)
                if action == "walk_in" { Text("Walk-ins have no loyalty account and receive no email.").font(.caption) }
                if let message { Text(message).foregroundStyle(.red) }
                Button(busy ? "Saving…" : "Save") { Task { await save() } }
            }.disabled(busy).navigationTitle(action == "block" ? "Time off" : "Walk-in")
                .toolbar { Button("Close") { dismiss() }.disabled(busy) }
        }.interactiveDismissDisabled(busy)
    }
    private func save() async {
        busy = true
        var payload: [String: Any] = ["action": action, "id": requestID, "date": date]
        if action == "block" { payload["start"] = start; payload["end"] = end; payload["reason"] = notes }
        else { payload["time"] = start; payload["serviceId"] = service; payload["name"] = name; payload["notes"] = notes }
        do { let _: Saved = try await client.request("api/admin/operations", body: payload); await onSaved(); dismiss() }
        catch { message = error.localizedDescription + " Refresh the day before retrying if the outcome is unclear." }
        busy = false
    }
}
struct RemoveBlockView: View {
    let block: TimeOff
    let onSaved: () async -> Void
    @EnvironmentObject var client: Client
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var message: String?
    var body: some View {
        Form {
            Text(block.reason)
            Text("\(block.start_time)–\(block.end_time)")
            Text("Removing this block reopens available slots.")
            if let message { Text(message).foregroundStyle(.red) }
            Button("Confirm removal", role: .destructive) {
                busy = true
                Task {
                    do { let _: Saved = try await client.request("api/admin/operations", body: ["action": "unblock", "id": block.id]); await onSaved(); dismiss() }
                    catch { message = error.localizedDescription }
                    busy = false
                }
            }.disabled(busy)
        }.navigationTitle("Time off")
    }
}
