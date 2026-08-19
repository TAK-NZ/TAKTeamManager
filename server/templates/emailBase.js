/**
 * Wraps email body content in the TAK.NZ branded HTML email template,
 * matching the Authentik email base template design.
 *
 * @param {string} bodyHtml - the inner content HTML (placed inside the content area)
 * @returns {string} full HTML email document
 */
function wrapInBrandedTemplate(bodyHtml) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width">
    <style type="text/css">
      body {
        font-family: Arial, sans-serif;
        font-size: 14px;
        color: #212124;
        margin: 0;
        padding: 0;
      }
      h1, h2 {
        font-family: Arial, sans-serif;
        font-weight: 700;
        margin: 0;
        padding: 10px 0;
      }
      h1 { font-size: 22px; }
      h2 { font-size: 18px; }
      .btn-primary {
        text-decoration: none;
        color: #FFF !important;
        background-color: #348eda;
        border: solid #348eda;
        border-width: 10px 20px;
        line-height: 2em;
        font-weight: bold;
        text-align: center;
        cursor: pointer;
        display: inline-block;
        border-radius: 4px;
      }
      .content-body {
        padding: 20px 0;
        line-height: 1.6;
      }
      .content-body p {
        margin: 0 0 12px 0;
      }
    </style>
  </head>
  <body>
    <center>
      <div style="-ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; width: 100%; max-width: 448px; padding: 60px 20px; font-size: 14px;">
        <table border="0" align="center" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding: 20px; border: 1px solid #c1c1c1;">
              <table width="100%" style="background-color: #FFFFFF; border-spacing: 0; margin-top: 15px;" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 20px 0;">
                    <img src="https://tak.nz/images/logo/tak-nz-brand-wide.png" border="0" alt="TAK.NZ" style="max-width: 100%; max-height: 70px; height: auto;">
                  </td>
                </tr>
                <tr>
                  <td style="padding: 0 20px;">
                    <div class="content-body">
                      ${bodyHtml}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 20px 0; font-size: 12px; color: #666;">
              <a href="https://tak.nz/" style="color: #348eda; text-decoration: none;">Team Awareness &bull; Te m\u014dhio o te r\u014dp\u016b</a>
            </td>
          </tr>
        </table>
      </div>
    </center>
  </body>
</html>`;
}

module.exports = { wrapInBrandedTemplate };
