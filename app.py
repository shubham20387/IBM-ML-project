"""
=============================================================================
  AI-Powered Predictive Maintenance of Industrial Machinery
  Backend: Flask + IBM Watsonx.ai (Granite Model)
  Author : IBM Watsonx Integration Demo
=============================================================================
"""

import os
import json
import pathlib
import requests
from datetime import datetime
from flask import Flask, render_template, request, jsonify, session
from flask_cors import CORS
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Load environment variables from .env
# Always resolve relative to this file so it works from any working directory
# ---------------------------------------------------------------------------
_ENV_PATH = pathlib.Path(__file__).parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH, override=True)

# ---------------------------------------------------------------------------
#  AGENT_INSTRUCTIONS — Customise agent behaviour, tone, safety, and repairs
# ---------------------------------------------------------------------------
AGENT_INSTRUCTIONS = """
You are an expert AI Predictive Maintenance Engineer specialising in industrial
machinery. Your sole purpose is to assist maintenance teams with:

1. FAULT DIAGNOSIS  – Analyse sensor readings, error codes, and symptom
   descriptions to predict failures BEFORE they happen.
2. REPAIR GUIDANCE  – Provide clear, step-by-step repair or servicing
   instructions specific to the identified fault.
3. SAFETY WARNINGS  – Always prepend a ⚠️ SAFETY PRECAUTIONS block before
   any repair instructions.

────────────────────────────────────────────────────────────────────────────
TONE & STYLE
────────────────────────────────────────────────────────────────────────────
• Be concise, technical, and professional.
• Use numbered lists for steps; bullet points for warnings.
• Avoid jargon that a trained maintenance technician would not recognise.
• Acknowledge uncertainty — if data is insufficient say so and ask a
  targeted clarifying question.

────────────────────────────────────────────────────────────────────────────
SAFETY RULES  (non-negotiable — always include these)
────────────────────────────────────────────────────────────────────────────
• LOCKOUT / TAGOUT (LOTO) must be applied before any physical intervention.
• Verify zero-energy state with a calibrated meter before touching live parts.
• Wear appropriate PPE: safety glasses, insulated gloves, steel-toe boots.
• Never bypass safety interlocks, guards, or emergency-stop circuits.
• Confirm machine is cool before touching heat-generating components.
• Two-person rule for heavy or high-voltage equipment.
• After repair, run a controlled test cycle before returning to full load.

────────────────────────────────────────────────────────────────────────────
REPAIR PREFERENCES
────────────────────────────────────────────────────────────────────────────
• Prefer manufacturer-recommended parts and torque specs where known.
• Suggest predictive-maintenance schedules after a repair (e.g. re-check in
  500 operating hours, lubricate every 250 hours, etc.).
• If a fault is recurring, escalate to root-cause analysis and suggest
  design improvements or spare-parts stocking.

────────────────────────────────────────────────────────────────────────────
RESPONSE STRUCTURE  (follow this order every time)
────────────────────────────────────────────────────────────────────────────
1. 🔍 DIAGNOSIS SUMMARY
2. ⚠️  SAFETY PRECAUTIONS
3. 🔧 STEP-BY-STEP REPAIR INSTRUCTIONS
4. 🛡️  POST-REPAIR CHECKS & PREVENTIVE SCHEDULE
5. 📋 RECOMMENDED SPARE PARTS / TOOLS

────────────────────────────────────────────────────────────────────────────
SCOPE LIMITS
────────────────────────────────────────────────────────────────────────────
• Only answer questions related to industrial machinery maintenance.
• For non-maintenance queries, politely redirect the user.
"""

# ---------------------------------------------------------------------------
#  Machine type catalogue — used to enrich prompts
# ---------------------------------------------------------------------------
MACHINE_CATALOGUE = {
    "compressor": "Reciprocating / rotary air compressor",
    "pump":       "Centrifugal or positive-displacement pump",
    "conveyor":   "Belt or roller conveyor system",
    "motor":      "AC/DC electric drive motor",
    "turbine":    "Steam or gas turbine",
    "cnc":        "CNC machining centre (milling / turning)",
    "robot":      "Industrial robotic arm",
    "hvac":       "HVAC / chiller plant",
    "generator":  "Diesel or gas generator set",
    "crane":      "Overhead / gantry crane",
    "press":      "Hydraulic or mechanical press",
    "boiler":     "Steam boiler / pressure vessel",
}

# ---------------------------------------------------------------------------
#  Flask App Initialisation
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "change-me-in-production")
CORS(app)

# ---------------------------------------------------------------------------
#  IBM Cloud credentials (loaded from .env)
# ---------------------------------------------------------------------------
IBM_API_KEY        = os.getenv("IBM_API_KEY")
IBM_IAM_URL        = os.getenv("IBM_IAM_URL", "https://iam.cloud.ibm.com/identity/token")

# Watsonx.ai text-generation endpoint (foundation model — NOT a deployment prediction URL)
WATSONX_URL        = os.getenv(
    "WATSONX_URL",
    "https://us-south.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29",
)
WATSONX_PROJECT_ID = os.getenv("WATSONX_PROJECT_ID", "")   # optional; leave blank if not needed
WATSONX_MODEL_ID   = os.getenv("WATSONX_MODEL_ID", "ibm/granite-3-8b-instruct")

# ---------------------------------------------------------------------------
#  IAM Token Cache
# ---------------------------------------------------------------------------
_token_cache = {"token": None, "expires_at": 0}


def get_iam_token() -> str:
    """Fetch (or return cached) IBM Cloud IAM bearer token."""
    now = datetime.utcnow().timestamp()
    if _token_cache["token"] and now < _token_cache["expires_at"] - 60:
        return _token_cache["token"]

    resp = requests.post(
        IBM_IAM_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
            "apikey": IBM_API_KEY,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    _token_cache["token"]      = data["access_token"]
    _token_cache["expires_at"] = now + data.get("expires_in", 3600)
    return _token_cache["token"]


# ---------------------------------------------------------------------------
#  Build the full prompt sent to Granite
# ---------------------------------------------------------------------------
def build_prompt(user_message: str, machine_type: str, history: list) -> str:
    machine_desc = MACHINE_CATALOGUE.get(machine_type.lower(), machine_type)

    # Condense conversation history (last 6 turns to stay within context)
    history_text = ""
    for turn in history[-6:]:
        role  = "User"      if turn["role"] == "user"      else "Assistant"
        history_text += f"{role}: {turn['content']}\n"

    prompt = f"""{AGENT_INSTRUCTIONS}

════════════════════════════════════════════════════════════════════════════
CONTEXT
════════════════════════════════════════════════════════════════════════════
Machine Type  : {machine_desc}
Timestamp     : {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}

CONVERSATION HISTORY:
{history_text}
════════════════════════════════════════════════════════════════════════════
USER QUERY
════════════════════════════════════════════════════════════════════════════
{user_message}

Please respond following the structured RESPONSE STRUCTURE defined above.
"""
    return prompt


# ---------------------------------------------------------------------------
#  Call IBM Watsonx.ai Foundation Model (text generation)
# ---------------------------------------------------------------------------
def call_watsonx(prompt: str) -> str:
    """
    Send prompt to the Watsonx.ai /ml/v1/text/generation endpoint.

    This uses the foundation-model API — completely separate from the
    structured-ML /predictions endpoint.  The payload follows the
    Watsonx text-generation schema documented at:
    https://cloud.ibm.com/apidocs/watsonx-ai#text-generation
    """
    token = get_iam_token()

    payload: dict = {
        "model_id": WATSONX_MODEL_ID,
        "input":    prompt,
        "parameters": {
            "decoding_method": "greedy",
            "max_new_tokens":  1500,
            "min_new_tokens":  50,
            "stop_sequences":  [],
            "repetition_penalty": 1.1,
        },
    }

    # project_id is required by the API when calling foundation models
    if WATSONX_PROJECT_ID:
        payload["project_id"] = WATSONX_PROJECT_ID

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
        "Accept":        "application/json",
    }

    response = requests.post(
        WATSONX_URL,
        headers=headers,
        json=payload,
        timeout=120,
    )
    response.raise_for_status()

    result = response.json()

    # Standard Watsonx text-generation response shape:
    # { "results": [{ "generated_text": "...", "stop_reason": "..." }] }
    try:
        results = result.get("results", [])
        if results:
            return results[0].get("generated_text", "").strip()
        # Fallback — surface raw JSON so errors are visible in the chat
        return json.dumps(result, indent=2)
    except (IndexError, KeyError, TypeError) as exc:
        return f"[Response parsing error: {exc}]\n\nRaw: {json.dumps(result)}"


# ---------------------------------------------------------------------------
#  Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """Serve the main chat UI."""
    session.setdefault("history", [])
    return render_template("index.html", machines=list(MACHINE_CATALOGUE.keys()))


@app.route("/api/chat", methods=["POST"])
def chat():
    """Main chat endpoint — receives user message, calls Watsonx, returns reply."""
    data         = request.get_json(force=True)
    user_message = data.get("message", "").strip()
    machine_type = data.get("machine_type", "motor").strip()

    if not user_message:
        return jsonify({"error": "Empty message"}), 400

    # Maintain per-session history
    history = session.get("history", [])
    history.append({"role": "user", "content": user_message})

    try:
        prompt   = build_prompt(user_message, machine_type, history)
        ai_reply = call_watsonx(prompt)
    except requests.exceptions.HTTPError as http_err:
        ai_reply = (
            f"⚠️ IBM Watsonx API error: {http_err.response.status_code} — "
            f"{http_err.response.text[:300]}"
        )
    except requests.exceptions.ConnectionError:
        ai_reply = "⚠️ Cannot reach IBM Watsonx. Check your network / endpoint."
    except Exception as exc:                        # noqa: BLE001
        ai_reply = f"⚠️ Unexpected error: {exc}"

    history.append({"role": "assistant", "content": ai_reply})
    session["history"] = history[-20:]  # Keep last 20 turns

    return jsonify({
        "reply":        ai_reply,
        "machine_type": machine_type,
        "timestamp":    datetime.utcnow().strftime("%H:%M"),
    })


@app.route("/api/clear", methods=["POST"])
def clear_history():
    """Reset conversation history for the current session."""
    session["history"] = []
    return jsonify({"status": "cleared"})


@app.route("/api/machines", methods=["GET"])
def machines():
    """Return available machine types."""
    return jsonify(MACHINE_CATALOGUE)


@app.route("/api/health", methods=["GET"])
def health():
    """Simple health-check endpoint."""
    return jsonify({
        "status":    "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "service":   "Predictive Maintenance AI",
    })


# ---------------------------------------------------------------------------
#  Entry Point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port  = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLASK_DEBUG", "True").lower() == "true"
    print(f"\n🚀  Predictive Maintenance AI running on http://0.0.0.0:{port}")
    print(f"   IBM Endpoint : {WATSONX_URL}")
    print(f"   Debug mode   : {debug}\n")
    app.run(host="0.0.0.0", port=port, debug=debug)
