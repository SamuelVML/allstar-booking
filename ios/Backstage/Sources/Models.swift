import Foundation

struct Booking: Decodable, Identifiable {
    var id: String { reference }
    let reference: String
    let revision: Int
    let source: String
    let customer_account_id: String?
    let service_name: String
    let price_cents: Int
    let appointment_date: String
    let start_time: String
    let end_time: String
    let customer_name: String
    let customer_email: String
    let customer_phone: String
    let notes: String
    let status: String
    let payment_method: String
    let payment_status: String
    var canPay: Bool { ["confirmed", "completed"].contains(status) && payment_status == "due_at_shop" && payment_method != "stripe" }
}
struct TimeOff: Decodable, Identifiable {
    let id: String
    let start_time: String
    let end_time: String
    let reason: String
}
struct Service: Decodable, Identifiable {
    let id: String
    let name: String
    let priceCents: Int
}
struct Day: Decodable {
    let date: String
    let email: String
    let bookings: [Booking]
    let blocks: [TimeOff]
    let services: [Service]
    var booked: Int { bookings.filter { ["confirmed", "completed"].contains($0.status) }.reduce(0) { $0 + $1.price_cents } }
    var paid: Int { bookings.filter { $0.payment_status == "paid" }.reduce(0) { $0 + $1.price_cents } }
}
struct Customer: Decodable, Identifiable {
    let id: String
    let name: String
    let email: String
    let phone: String
    let loyalty_points: Int
    let completed_visits: Int
}
struct Visit: Decodable, Identifiable {
    var id: String { reference }
    let reference: String
    let service_name: String
    let appointment_date: String
    let start_time: String
    let status: String
    let payment_status: String
    let price_cents: Int
}
struct Customers: Decodable { let customers: [Customer] }
struct Visits: Decodable { let visits: [Visit] }
struct Times: Decodable { let times: [String] }
struct Saved: Decodable { let notificationsSent: Bool? }
struct APIError: Decodable { let error: String }
func money(_ cents: Int) -> String { (Double(cents) / 100).formatted(.currency(code: "EUR")) }
func shopDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}
