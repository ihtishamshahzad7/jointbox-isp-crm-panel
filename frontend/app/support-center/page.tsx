"use client";

import Hub from "../components/hub";
import Complaints from "../complaints/page";
import FieldJobs from "../field-jobs/page";
import Communication from "../communication/page";

/**
 * The customer-facing side of the day: what they reported, who is going out
 * to fix it, and what you told them.
 */
export default function SupportCenter() {
  return (
    <Hub
      storageKey="support"
      tabs={[
        { id: "complaints",    label: "Complaints",    hint: "Tickets raised by customers.", render: () => <Complaints /> },
        { id: "field-jobs",    label: "Field Jobs",    hint: "Installations and repairs assigned to staff.", render: () => <FieldJobs /> },
        { id: "communication", label: "Communication", hint: "SMS and email sent, and the templates behind them.", render: () => <Communication /> },
      ]}
    />
  );
}
