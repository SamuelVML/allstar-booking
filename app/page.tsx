import {
  ArrowRight,
  CalendarDays,
  GraduationCap,
  House,
  MapPin,
  Phone,
  Scissors,
  Sparkles,
  Users,
} from "lucide-react";
import { formatPrice, SERVICES } from "@/lib/booking";

const bookingUrl = "/book";
const whatsappUrl =
  "https://wa.me/31686357350?text=Hi%20All%20Star%2C%20I%27m%20interested%20in%20the%20Mobile%20Barber.";

const mobileServices = [
  { name: "House calls", icon: House },
  { name: "Pop-up locations", icon: MapPin },
  { name: "Companies", icon: Users },
  { name: "Events", icon: CalendarDays },
];

const programmes = [
  "Barber Program",
  "Fade Masterclass",
  "1-to-1 Coaching",
  "Team Training",
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="All Star Barbershop home">
          <span>ALL STAR</span>
          <small>BARBERSHOP</small>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#top">Home</a>
          <a href="#barbershop">Barbershop</a>
          <a href="#mobile">Mobile Barber</a>
          <a href="#academy">Academy</a>
          <a href="#contact">Contact</a>
        </nav>
        <a className="button button-small" href={bookingUrl}>
          Book now
        </a>
        <a className="mobile-menu" href={bookingUrl} aria-label="Book an appointment">
          <CalendarDays aria-hidden="true" />
        </a>
      </header>

      <section className="hero" id="top">
        <img
          src="/hero-barber.webp"
          alt="Barber creating a precision fade in a modern barbershop"
        />
        <div className="hero-copy">
          <h1>
            Stay fresh.
            <br />
            Wherever you are.
          </h1>
          <p>
            Precision cuts in our Eindhoven barbershop — and soon, on the road.
          </p>
          <div className="button-row">
            <a className="button" href={bookingUrl}>
              Book an appointment <ArrowRight aria-hidden="true" />
            </a>
            <a className="button button-outline" href="#mobile">
              Discover Mobile Barber
            </a>
          </div>
        </div>
        <div className="hero-foot">
          <span>Eindhoven</span>
          <i />
          <span>Cuts · People · Culture</span>
        </div>
      </section>

      <section className="services section-light" id="barbershop">
        <div className="section-heading">
          <h2>Services & prices</h2>
          <p>A clear menu. No confusing combinations.</p>
        </div>
        <div className="service-list">
          {SERVICES.map((service, index) => (
            <a
              href={service.isAddOn ? "/book?addOn=colour" : `/book?service=${service.id}`}
              className="service-row"
              key={service.id}
            >
              <span className="service-number">0{index + 1}</span>
              <strong>{service.name}</strong>
              <span>{service.isAddOn ? "+" : ""}{service.durationMinutes} min</span>
              <b>{service.isAddOn ? "+" : ""}{formatPrice(service.priceCents)}</b>
              <ArrowRight aria-hidden="true" />
            </a>
          ))}
        </div>
        <div className="split-callout">
          <div>
            <Scissors aria-hidden="true" />
            <h3>Book your chair</h3>
          </div>
          <p>
            Choose your service and time. Pay at the shop after your appointment.
          </p>
          <a className="button" href={bookingUrl}>
            Book now <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </section>

      <section className="mobile-section" id="mobile">
        <div className="mobile-copy">
          <h2>
            All Star
            <br />
            comes to you.
          </h2>
          <p>
            Mobile barbering for house calls, strategic locations, companies and
            events.
          </p>
          <div className="button-row">
            <a className="button" href={whatsappUrl}>
              Join the launch list <ArrowRight aria-hidden="true" />
            </a>
            <a className="button button-outline-dark" href={whatsappUrl}>
              Request a mobile booking
            </a>
          </div>
        </div>
        <figure>
          <img
            src="/mobile-barber.webp"
            alt="Concept of a premium mobile barbershop van"
          />
          <figcaption>Mobile Barber concept image</figcaption>
        </figure>
        <div className="mobile-modes">
          {mobileServices.map(({ name, icon: Icon }) => (
            <div key={name}>
              <Icon aria-hidden="true" />
              <span>{name}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="academy section-light" id="academy">
        <div className="academy-copy">
          <GraduationCap aria-hidden="true" />
          <h2>Learn the craft.</h2>
          <p>Practical barber training, masterclasses and personal coaching.</p>
          <div className="programme-list">
            {programmes.map((programme) => (
              <span key={programme}>{programme}</span>
            ))}
          </div>
          <a
            className="button"
            href="https://all-star-barbershop.com/academy/"
          >
            Explore the Academy <ArrowRight aria-hidden="true" />
          </a>
        </div>
        <figure>
          <img
            src="/academy-training.webp"
            alt="Barber instructor demonstrating a fade technique to students"
          />
          <figcaption>Academy concept image</figcaption>
        </figure>
      </section>

      <section className="contact" id="contact">
        <div>
          <Sparkles aria-hidden="true" />
          <h2>Visit All Star.</h2>
          <p>Bakkerstraat 48, 5612 EP Eindhoven</p>
        </div>
        <div className="contact-actions">
          <a href="https://www.google.com/maps/search/?api=1&query=Bakkerstraat+48+5612+EP+Eindhoven">
            <MapPin aria-hidden="true" /> Get directions
          </a>
          <a href="tel:+31686357350">
            <Phone aria-hidden="true" /> Call
          </a>
          <a href="https://wa.me/31686357350">WhatsApp</a>
        </div>
      </section>

      <footer>
        <a className="brand" href="#top">
          <span>ALL STAR</span>
          <small>BARBERSHOP</small>
        </a>
        <p>Stay fresh.</p>
        <div>
          <a href="#barbershop">Barbershop</a>
          <a href="#mobile">Mobile Barber</a>
          <a href="#academy">Academy</a>
          <a href="#contact">Contact</a>
        </div>
      </footer>
    </main>
  );
}
