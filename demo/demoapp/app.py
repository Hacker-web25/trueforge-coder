# Throwaway Flask app used only to show the new `flask config` command masking secrets.
#   cd demo/demoapp && flask --app app config
from flask import Flask

app = Flask(__name__)
app.config["SECRET_KEY"] = "super-secret-value"
app.config["API_TOKEN"] = "tok_123456"
app.config["DB_PASSWORD"] = "hunter2"
app.config["STRIPE_KEY"] = "sk_live_abc"
app.config["PAGE_SIZE"] = 20
app.config["SITE_NAME"] = "Demo"
