const express = require("express");
const bodyParser = require("body-parser");
const myRouter = express.Router();
const mailer = require("nodemailer-promise");

myRouter.use(bodyParser.json());

/*
|--------------------------------------------------------------------------
| SEND OTP
|--------------------------------------------------------------------------
| POST /api/emailotp/sendotp
|
| Body:
| {
|   "email": "user@gmail.com",
|   "otp": "123456"
| }
|--------------------------------------------------------------------------
*/

myRouter.post("/api/emailotp/sendotp", async (req, res) => {
    try {
        console.log("📧 Skyllabus Send OTP API called");

        const { email, otp } = req.body || {};

        console.log("📩 Target email:", email);

        // Check email
        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email not specified"
            });
        }

        // Check OTP
        if (!otp) {
            return res.status(400).json({
                success: false,
                message: "OTP not specified"
            });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email address"
            });
        }

        // Send OTP
        const emailSent = await sendMail(email, otp);

        if (emailSent) {
            return res.status(200).json({
                success: true,
                message: "OTP sent successfully"
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to send OTP"
        });

    } catch (error) {
        console.error("❌ Skyllabus Send OTP API error:", error);

        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
});


/*
|--------------------------------------------------------------------------
| SEND MAIL
|--------------------------------------------------------------------------
*/

async function sendMail(target, otp) {
    try {
        const eid = "noreply.skyllabus@gmail.com";

        const sendEmail = mailer.config({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: {
                user: eid,
                pass: 'rlmi iaon xlsl zukm'
            }
        });

        const message = {
            from: `"Skyllabus" <${eid}>`,
            to: target,

            subject: `[ ${otp} ] OTP for authenticating Skyllabus`,

            text: `
Your OTP for authenticating Skyllabus is: ${otp}

Never share your OTP with anyone.

If you did not request this OTP, please ignore this email.

© Skyllabus
            `,

            html: `
                <div style="
                    font-family: Arial, sans-serif;
                    max-width: 600px;
                    margin: auto;
                    padding: 30px;
                    border: 1px solid #ddd;
                    border-radius: 10px;
                ">

                    <h2>Skyllabus Email Verification</h2>

                    <p>
                        Your OTP for authenticating Skyllabus is:
                    </p>

                    <div style="
                        text-align: center;
                        font-size: 32px;
                        font-weight: bold;
                        letter-spacing: 8px;
                        padding: 20px;
                        background: #f5f5f5;
                        border-radius: 8px;
                    ">
                        ${otp}
                    </div>

                    <p>
                        Please do not share this OTP with anyone.
                    </p>

                    <p style="color: #777;">
                        If you did not request this OTP, please ignore this email.
                    </p>

                    <hr>

                    <p style="font-size: 12px; color: #999;">
                        © Skyllabus
                    </p>

                </div>
            `
        };

        const response = await sendEmail(message).catch((error) => {
            console.error("❌ Skyllabus Gmail error:", error);
            return null;
        });

        if (response) {
            console.log("✅ Skyllabus OTP email sent successfully");
            return true;
        }

        console.log("❌ Skyllabus OTP email failed");
        return false;

    } catch (error) {
        console.error("❌ Skyllabus sendMail error:", error);
        return false;
    }
}


module.exports = myRouter;