# Specialty Risk Analysis

Relative MPL severity/frequency tiers (general guidance; adjust for procedures). The "very high"
and "high" tiers include every class on the DPL manual's **high-risk carve-out** (§1.6), for which
loss runs can never be waived.

| Tier      | Typical specialties                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Very high | Neurosurgery, OB/GYN with deliveries, spine surgery, cardiothoracic and vascular surgery, bariatric surgery, BBL / liposuction over 1,000 cc, emergency medicine where DPL is the primary individual policy    |
| High      | General surgery, orthopaedic surgery, interventional pain management, anesthesiology, plastic / cosmetic surgery, radiology (interventional), cardiology (interventional)                                      |
| Moderate  | Internal medicine, family medicine with minor procedures, gastroenterology, urology, dermatology with surgery, urgent care, aesthetic medicine / MedSpa (non-surgical), weight-loss medicine, ketamine therapy |
| Lower     | Psychiatry (non-ECT), pathology, family medicine without procedures, pediatrics (non-NICU), telehealth-only primary care, administrative-only medical director                                                 |

Adjust for:

- **Classification rule (DPL §4.6):** the physician is classed by the **highest** classification
  in which they spend **more than 25%** of their time. A claimed specialty that ignores a
  higher-tier activity above 25% is under-classification: report it under `inconsistencies`.
- **Procedure mix**: obstetrics, spine, cosmetic or bariatric procedures raise the tier.
- **Setting**: office-based surgery and ambulatory surgery centres bring different exposure than
  hospital-based care (Florida office surgery: §5.7).
- **Mismatch** between the claimed specialty and the NPI taxonomy: `inconsistencies` only.
- **Jurisdiction**: some states are high-severity venues. Note the state and say whether it is a
  venue concern, but don't invent statistics. The manual singles out Florida, New York and
  Michigan (statutes of limitation / repose, corporate practice) and Pennsylvania (Mcare).
- **Telehealth / multi-state** practice adds licensure and jurisdiction exposure (territory: §2.4).
- **Volume**: radiology above 100 reads a day (§3.5).
