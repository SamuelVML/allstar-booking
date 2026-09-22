/**
 * Customer-facing copy in English and Dutch.
 *
 * Backstage stays English-only — it has a single operator. The public site and
 * booking flow are bilingual because All Star's customers are not.
 */

export type Language = "en" | "nl";

export const LANGUAGES: Language[] = ["en", "nl"];

export type Copy = (typeof COPY)["en"];

export const COPY = {
  en: {
    langToggle: "NL",
    langSwitchLabel: "Schakel over naar Nederlands",

    heroKicker: "Eindhoven · Bakkerstraat 48",
    heroTitle: "Stay fresh.",
    heroBody:
      "Precision cuts, beard work and colour. Book your chair in under a minute — pay online or at the shop.",

    servicesTitle: "Services & prices",
    servicesHint: "Tap to book",
    addOnNote: "Colour add-on available with most haircuts (+30 min · +€22,50).",

    howTitle: "How it works",
    howSteps: [
      {
        title: "Pick a service, date and time",
        body: "Only free times are shown. Book up to 60 days ahead.",
      },
      {
        title: "Pay online or at the shop",
        body: "Same price either way. Stripe online, or cash/card after your cut.",
      },
      {
        title: "Confirmation with a reference",
        body: "On screen and in your inbox. Change or cancel up to two hours before.",
      },
    ],

    mobileKicker: "Mobile Barber",
    mobileTitle: "All Star comes to you.",
    mobileBody:
      "Mobile barbering for house calls, strategic locations, companies and events.",
    mobileModes: ["House calls", "Pop-up locations", "Companies", "Events"],
    mobileCta: "Join the launch list",

    academyKicker: "Academy",
    academyTitle: "Learn the craft.",
    academyBody: "Practical barber training, masterclasses and personal coaching.",
    programmes: ["Barber Program", "Fade Masterclass", "1-to-1 Coaching", "Team Training"],
    academyCta: "Explore the Academy",

    visitKicker: "Visit us",
    directions: "Directions",
    call: "Call",

    loyaltyTitle: "All Star points",
    loyaltyBody:
      "Every completed visit earns 1 point. At 10 points, your next full-service haircut and a haircare product are free.",
    footerTag: "Cuts · People · Culture",
    bookCta: "Book an appointment",

    home: "Home",
    backStep: "Back",
    step: "Step",
    of: "of",
    titles: [
      "Choose your service",
      "Pick a date",
      "Pick a time",
      "Your details",
      "How do you pay?",
      "Check & confirm",
      "Confirming",
    ],
    hints: [
      "Prices include VAT. Duration is the time in the chair.",
      "We're closed on Sundays. Book up to 60 days ahead.",
      "Times are Eindhoven local. Booked times are shown crossed out.",
      "Your points and reminders are linked to your email.",
      "Same price either way. Choose what suits you.",
      "Check everything once — then confirm.",
      "",
    ],

    addOnTitle: "Add hair colour",
    today: "Today",
    closed: "Closed",
    openingOn: "Open",
    checkingTimes: "Checking available times…",
    noTimesTitle: "Fully booked",
    noTimesBody: "No times left on this day for this service.",
    pickAnotherDate: "Pick another date",
    unavailableLegend: "Already booked or outside opening hours",
    morning: "Morning",
    afternoon: "Afternoon",
    evening: "Evening",

    fullName: "Full name",
    phone: "Phone",
    email: "Email",
    emailHint: "Confirmation and reminders go here.",
    notes: "Notes · optional",
    errName: "Enter your name.",
    errPhone: "Enter a phone number we can reach you on.",
    errEmail: "Enter a valid email address.",
    errTerms: "Please agree before continuing.",
    terms:
      "I'll let All Star know at least two hours ahead if I need to change or cancel.",
    reminders: "Send me a confirmation and a reminder.",
    marketing:
      "Occasional “Stay Fresh” offers and a nudge when it's time for your next cut. Optional.",

    payShopKicker: "At the shop",
    payShopTitle: "Pay after your cut",
    payShopBody: "Cash or card at the counter. Nothing is charged now.",
    payOnlineKicker: "Online now",
    payOnlineTitle: "Pay securely online",
    payOnlineBody:
      "Card, iDEAL or Apple Pay via Stripe. Your slot is held for 30 minutes while you pay.",
    payOnlineOff: "Online payment is temporarily unavailable.",
    footShop: "No payment is taken now. You pay at the shop after your appointment.",
    footOnline:
      "You'll be sent to Stripe's secure checkout. Your slot is reserved for 30 minutes.",

    yourAppointment: "Your appointment",
    edit: "Edit",
    total: "Total",
    service: "Service",
    date: "Date",
    time: "Time",
    payment: "Payment",
    nameK: "Name",
    contact: "Contact",
    loyaltyReview: "1 All Star point is added when your visit is completed.",
    failTitle: "We couldn't confirm your booking",
    retry: "Try again",
    continue: "Continue",
    confirm: "Confirm booking",
    payOnline: "Pay online",
    confirming: "Confirming your booking…",
    openingCheckout: "Opening secure checkout…",
    confirmingHint: "Your details are kept if this fails — nothing is lost.",

    successKickerShop: "Booking confirmed · Pay at the shop",
    successKickerOnline: "Payment received · Booking confirmed",
    successTitle: "See you at All Star.",
    successBody: "A confirmation is on its way to your email.",
    reference: "Reference",
    addToCalendar: "Add to calendar",
    loyaltyTitleShort: "All Star points",
    loyaltySuccess:
      "Your point is added after the visit. 10 points = a free full-service haircut and a haircare product.",
    changeTitle: "Need to change or cancel?",
    changeBody:
      "Message or call All Star at least two hours before your appointment. Online payments are not refunded automatically — we'll sort it with you directly.",
    backToSite: "Back to All Star",
    paidShop: "Pay at the shop",
    paidOnline: "Paid online",

    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    closedWord: "Closed",

    recKicker: "Samaritan recommends",
    recLoading: "Samaritan is finding your best fit…",
    recAccept: "Use this time",
    recDismiss: "Choose myself",
    recNone: "No fitting time in the next two weeks — pick a date below.",
    recRestore: "Show Samaritan's recommendation again",
    recTag: "Samaritan's pick",
    recReasonFirst: "The first open chair for this service — no waiting.",
    recReasonGap:
      "Fits neatly between existing appointments, so the shop keeps its rhythm.",

    genericError: "Something went wrong. Please try again.",
  },

  nl: {
    langToggle: "EN",
    langSwitchLabel: "Switch to English",

    heroKicker: "Eindhoven · Bakkerstraat 48",
    heroTitle: "Stay fresh.",
    heroBody:
      "Strakke kapsels, baardwerk en kleur. Boek je stoel binnen een minuut — betaal online of in de shop.",

    servicesTitle: "Diensten & prijzen",
    servicesHint: "Tik om te boeken",
    addOnNote: "Kleur-add-on mogelijk bij de meeste knipbeurten (+30 min · +€22,50).",

    howTitle: "Zo werkt het",
    howSteps: [
      {
        title: "Kies dienst, datum en tijd",
        body: "Alleen vrije tijden worden getoond. Boek tot 60 dagen vooruit.",
      },
      {
        title: "Betaal online of in de shop",
        body: "Dezelfde prijs. Online via Stripe, of contant/pin na je knipbeurt.",
      },
      {
        title: "Bevestiging met referentie",
        body: "Direct op je scherm en in je mail. Wijzigen kan tot twee uur van tevoren.",
      },
    ],

    mobileKicker: "Mobile Barber",
    mobileTitle: "All Star komt naar je toe.",
    mobileBody:
      "Mobiel barbieren voor huisbezoeken, pop-uplocaties, bedrijven en evenementen.",
    mobileModes: ["Huisbezoeken", "Pop-uplocaties", "Bedrijven", "Evenementen"],
    mobileCta: "Zet me op de lanceerlijst",

    academyKicker: "Academy",
    academyTitle: "Leer het vak.",
    academyBody: "Praktische barbieropleiding, masterclasses en persoonlijke coaching.",
    programmes: ["Barber Program", "Fade Masterclass", "1-op-1 coaching", "Teamtraining"],
    academyCta: "Bekijk de Academy",

    visitKicker: "Kom langs",
    directions: "Route",
    call: "Bellen",

    loyaltyTitle: "All Star punten",
    loyaltyBody:
      "Elk afgerond bezoek levert 1 punt op. Bij 10 punten zijn je volgende full-service knipbeurt en een haarproduct gratis.",
    footerTag: "Cuts · People · Culture",
    bookCta: "Afspraak boeken",

    home: "Home",
    backStep: "Terug",
    step: "Stap",
    of: "van",
    titles: [
      "Kies je dienst",
      "Kies een datum",
      "Kies een tijd",
      "Jouw gegevens",
      "Hoe betaal je?",
      "Controleer & bevestig",
      "Bevestigen",
    ],
    hints: [
      "Prijzen incl. btw. Duur is de tijd in de stoel.",
      "Zondag gesloten. Boek tot 60 dagen vooruit.",
      "Tijden zijn lokale tijd Eindhoven. Bezette tijden zijn doorgestreept.",
      "Je punten en herinneringen zijn gekoppeld aan je e-mail.",
      "Dezelfde prijs, hoe je ook betaalt.",
      "Controleer alles nog één keer — en bevestig.",
      "",
    ],

    addOnTitle: "Haar kleuren toevoegen",
    today: "Vandaag",
    closed: "Gesloten",
    openingOn: "Open",
    checkingTimes: "Beschikbare tijden ophalen…",
    noTimesTitle: "Volgeboekt",
    noTimesBody: "Geen tijden meer op deze dag voor deze dienst.",
    pickAnotherDate: "Kies een andere datum",
    unavailableLegend: "Al geboekt of buiten openingstijden",
    morning: "Ochtend",
    afternoon: "Middag",
    evening: "Avond",

    fullName: "Volledige naam",
    phone: "Telefoon",
    email: "E-mail",
    emailHint: "Hier komen je bevestiging en herinnering.",
    notes: "Opmerkingen · optioneel",
    errName: "Vul je naam in.",
    errPhone: "Vul een telefoonnummer in waarop we je kunnen bereiken.",
    errEmail: "Vul een geldig e-mailadres in.",
    errTerms: "Ga akkoord om verder te gaan.",
    terms:
      "Ik laat All Star minimaal twee uur van tevoren weten als ik wil wijzigen of annuleren.",
    reminders: "Stuur me een bevestiging en een herinnering.",
    marketing:
      "Af en toe een “Stay Fresh”-aanbieding en een seintje als het tijd is voor je volgende knipbeurt. Optioneel.",

    payShopKicker: "In de shop",
    payShopTitle: "Betaal na je knipbeurt",
    payShopBody: "Contant of pin aan de balie. Er wordt nu niets afgeschreven.",
    payOnlineKicker: "Nu online",
    payOnlineTitle: "Veilig online betalen",
    payOnlineBody:
      "Kaart, iDEAL of Apple Pay via Stripe. Je tijd blijft 30 minuten gereserveerd terwijl je betaalt.",
    payOnlineOff: "Online betalen is tijdelijk niet beschikbaar.",
    footShop:
      "Er wordt nu niets afgeschreven. Je betaalt in de shop na je afspraak.",
    footOnline:
      "Je gaat naar de beveiligde checkout van Stripe. Je tijd is 30 minuten gereserveerd.",

    yourAppointment: "Jouw afspraak",
    edit: "Wijzig",
    total: "Totaal",
    service: "Dienst",
    date: "Datum",
    time: "Tijd",
    payment: "Betaling",
    nameK: "Naam",
    contact: "Contact",
    loyaltyReview: "1 All Star punt wordt toegevoegd zodra je bezoek is afgerond.",
    failTitle: "We konden je boeking niet bevestigen",
    retry: "Opnieuw proberen",
    continue: "Verder",
    confirm: "Boeking bevestigen",
    payOnline: "Online betalen",
    confirming: "Je boeking bevestigen…",
    openingCheckout: "Beveiligde checkout openen…",
    confirmingHint:
      "Je gegevens blijven bewaard als dit mislukt — er gaat niets verloren.",

    successKickerShop: "Boeking bevestigd · Betaal in de shop",
    successKickerOnline: "Betaling ontvangen · Boeking bevestigd",
    successTitle: "Tot bij All Star.",
    successBody: "Een bevestiging is onderweg naar je e-mail.",
    reference: "Referentie",
    addToCalendar: "In agenda zetten",
    loyaltyTitleShort: "All Star punten",
    loyaltySuccess:
      "Je punt wordt na het bezoek toegevoegd. 10 punten = een gratis full-service knipbeurt en een haarproduct.",
    changeTitle: "Wijzigen of annuleren?",
    changeBody:
      "Stuur een bericht of bel All Star minimaal twee uur voor je afspraak. Online betalingen worden niet automatisch terugbetaald — dat regelen we samen.",
    backToSite: "Terug naar All Star",
    paidShop: "Betalen in de shop",
    paidOnline: "Online betaald",

    days: ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"],
    closedWord: "Gesloten",

    recKicker: "Samaritan adviseert",
    recLoading: "Samaritan zoekt je beste tijd…",
    recAccept: "Deze tijd nemen",
    recDismiss: "Zelf kiezen",
    recNone: "Geen passende tijd in de komende twee weken — kies hieronder een datum.",
    recRestore: "Advies van Samaritan opnieuw tonen",
    recTag: "Keuze van Samaritan",
    recReasonFirst: "De eerste vrije stoel voor deze dienst — geen wachttijd.",
    recReasonGap:
      "Past precies tussen bestaande afspraken, zodat de shop zijn ritme houdt.",

    genericError: "Er ging iets mis. Probeer het opnieuw.",
  },
} satisfies Record<Language, Record<string, unknown>>;

/** Dutch service names, keyed by the catalogue ids in `lib/booking.ts`. */
const SERVICE_NAMES_NL: Record<string, string> = {
  haircut: "Knipbeurt",
  "student-haircut": "Studentenknipbeurt",
  "kids-haircut": "Kinderknipbeurt",
  "line-up": "Line-up",
  "beard-trim-shape": "Baard trimmen & vormen",
  "haircut-beard": "Knipbeurt + baard",
  "haircut-colour": "Knipbeurt + kleur",
  "haircut-beard-colour": "Knipbeurt + baard + kleur",
  "colour-add-on": "Kleur-add-on",
};

/**
 * The service name in the chosen language. Prices, durations and ids always
 * come from the catalogue — only the label is translated.
 */
export function serviceLabel(id: string, fallback: string, language: Language) {
  if (language === "nl") return SERVICE_NAMES_NL[id] ?? fallback;
  return fallback;
}

export const COLOUR_ADD_ON_SUFFIX: Record<Language, string> = {
  en: " + colour",
  nl: " + kleur",
};

export function locale(language: Language) {
  return language === "nl" ? "nl-NL" : "en-GB";
}

export function isLanguage(value: string | undefined): value is Language {
  return value === "en" || value === "nl";
}
