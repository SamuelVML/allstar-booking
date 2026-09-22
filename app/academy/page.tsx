import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, StarMark } from "@/lib/icons";

export const metadata: Metadata = {
  title: "All Star Academy | Barber Training Eindhoven",
  description: "Practical barber education in Eindhoven: beginner training, fade masterclasses, 1-to-1 coaching and tailored team training.",
};

const programmes = [
  { title: "Barber Program", meta: "30 weeks · complete beginners", body: "A structured route from first principles to confident, job-ready barbering. Learn fundamentals, modern techniques, client consultation and professional shop workflow, with practice between sessions." },
  { title: "Fade Masterclass", meta: "Advanced technique", body: "Focused training for barbers who want cleaner transitions, stronger shape and a more repeatable fade process." },
  { title: "1-to-1 Coaching", meta: "Personal coaching", body: "Individual coaching built around your current level, technique and development goals, with direct feedback and practical correction." },
  { title: "Custom Team Training", meta: "Salons & teams", body: "Tailored sessions for barber and salon teams, designed around the techniques, standards and workflow your team needs to improve." },
];

export default function AcademyPage() {
  return <main className="site academy-page">
    <header className="site-top">
      <Link className="brand" href="/"><StarMark /><span className="brand-name"><b>ALL STAR</b><span>ACADEMY · EINDHOVEN</span></span></Link>
      <Link className="btn btn-on-dark btn-s" href="/">Back to All Star</Link>
    </header>
    <section className="academy-hero">
      <div><p className="kicker">All Star Academy</p><h1 className="display display-xl">Learn the craft.</h1><p className="lead pretty">Practical, results-driven barber education — from complete beginner training to advanced skill courses, personal coaching and tailored team training.</p></div>
      <img src="/academy-training.webp" alt="Barber instructor demonstrating a fade technique to students" />
    </section>
    <section className="section academy-intro">
      <p className="kicker">Training · Courses · Coaching</p>
      <h2 className="display display-m">Built around real shop work.</h2>
      <p className="body pretty">Training is practical and structured around technique, workflow, confidence and repeatable progress. Choose the route that matches where you are now and where you want to go.</p>
    </section>
    <section className="academy-program-grid">
      {programmes.map((p, i) => <article className="academy-program" key={p.title}>
        <span className="service-no">{String(i + 1).padStart(2, "0")}</span>
        <p className="kicker">{p.meta}</p><h2 className="display display-s">{p.title}</h2><p>{p.body}</p>
      </article>)}
    </section>
    <section className="section section-dark academy-contact">
      <p className="kicker kicker-on-dark">Start a conversation</p>
      <h2 className="display display-m">Train at All Star.</h2>
      <p>Tell us which programme you are interested in and your current experience level. We will help you find the appropriate route.</p>
      <a className="btn btn-on-dark" href="mailto:info@all-star-barbershop.com?subject=All%20Star%20Academy%20enquiry">Academy enquiry <ArrowRight /></a>
    </section>
  </main>;
}
