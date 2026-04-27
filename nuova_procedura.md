using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Configuration;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;

namespace SpedireOnLinePostDocument.ApiBssi
{
    public class Function
    {
        private static string dbApiUrl = "https://web.spedireonline.cloud/globaltrs/sped-request/sendLdv"; // Modifica l'URL dell'API
        private static string dbApiToken = ConfigurationManager.AppSettings["dbApiToken"]; // Il tuo token di autenticazione

        public static int? StoreInDb(dynamic chatgptResponse, string descart)
        {
            try
            {
                // Crea l'oggetto da inviare
                var data = new
                {
                    idsped = "",  // L'ID deve essere mappato correttamente
                    destinatario = chatgptResponse.ragionesocialedestinazione ?? "",
                    referente = chatgptResponse.riferimentodestinazione ?? "",
                    short_address = chatgptResponse.indirizzodestinazione ?? "",
                    street_number = "",
                    short_city = chatgptResponse.cittadestinazione ?? "",
                    post_number = chatgptResponse.capdestinazione ?? "",
                    short_pr = chatgptResponse.provincidestinazione ?? "",
                    phone_number = chatgptResponse.telefonodestinazione ?? "",
                    email = chatgptResponse.emaildestinazione ?? "",
                    servizio = "",
                    stracc = "",
                    strsottacc = "",
                    importo = chatgptResponse.importocontrassegno ?? "",
                    collirow = chatgptResponse.numerocolli ?? "",
                    accessori = new
                    {
                        Ritiro = chatgptResponse.ritiro ?? false,
                        Triangolazione = chatgptResponse.triangolazione ?? false,
                        TimeDefinite = chatgptResponse.timedefinite ?? "",
                        KiReverse = chatgptResponse.kireverse ?? "",
                        Assicurazione = chatgptResponse.assicurazione ?? "",
                        Appuntamento = chatgptResponse.appuntamento ?? false,
                        ConsegnaAlPiano = chatgptResponse.consegnaalpiano ?? false,
                        ConAscensore = chatgptResponse.conascensore ?? false,
                        ConsSab = chatgptResponse.conssab ?? false,
                        ConsSera = chatgptResponse.conssera ?? false
                    },
                    colli = new[]
                    {
                    new
                    {
                        peso = chatgptResponse.peso ?? "",
                        altezza = chatgptResponse.altezza ?? "",
                        larghezza = chatgptResponse.larghezza ?? "",
                        profondita = chatgptResponse.profondita ?? ""
                    }
                },
                    peso_tassabile = chatgptResponse.peso ?? "",
                    Note = chatgptResponse.note ?? "",
                    NumeroRiferimento = chatgptResponse.documentn ?? "",
                    Contenuto = chatgptResponse.aspettobeni ?? "",
                    country = "",
                    id_fiscale = "",
                    metodo = "",
                    costospedizione = "",
                    capmitt = "",
                    flagass = "",
                    importoass = "",
                    naz = "",
                    colli_fedex = new[]
                    {
                    new
                    {
                        peso = chatgptResponse.peso ?? "",
                        altezza = chatgptResponse.altezza ?? "",
                        larghezza = chatgptResponse.larghezza ?? "",
                        profondita = chatgptResponse.profondita ?? "",
                        note = chatgptResponse.note ?? ""
                    }
                },
                    descart = descart,
                    idmarketplace = "26"
                };

                using (var client = new HttpClient())
                {
                    // Imposta i headers
                    client.DefaultRequestHeaders.Add("BSSI-AuthToken", dbApiToken);

                    // Serializza i dati in JSON
                    var jsonData = JsonConvert.SerializeObject(data);
                    var content = new StringContent(jsonData, Encoding.UTF8, "application/json");

                    // Esegui la richiesta POST
                    var response = client.PostAsync(dbApiUrl, content).Result;

                    // Controlla la risposta
                    if (response.IsSuccessStatusCode)
                    {
                        Console.WriteLine("Stored result in the database");
                        return (int)response.StatusCode;
                    }
                    else
                    {
                        Console.WriteLine($"Error storing result: {response.ReasonPhrase}");
                        return null;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error storing result in the database: {ex.Message}");
                return null;
            }
        }

        public static int? UploadFile(string filePath, string referenceId, string workflowName)
        {
            try
            {
                // Estrai il nome del file
                string filename = filePath;

                using (HttpClient client = new HttpClient())
                {
                    // Imposta i headers (aggiungi il token di autenticazione)
                    client.DefaultRequestHeaders.Add("BSSI-TokenKey", ConfigurationManager.AppSettings["BSSI-TokenKey"]);

                    // Crea il contenuto della richiesta multipart/form-data
                    using (MultipartFormDataContent form = new MultipartFormDataContent())
                    {
                        // Crea la parte JSON
                        var documentMeta = new
                        {
                            document = new
                            {
                                referenceId = referenceId,
                                name = filename,
                                contentType = "document/pdf",
                                meta = new
                                {
                                    imageType = "FILE",
                                    imageIndex = $"IMAGE_{referenceId}"
                                }
                            },
                            rules = new
                            {
                                workflowname = workflowName
                            }
                        };
                        string jsonContent = JsonConvert.SerializeObject(documentMeta);
                        ByteArrayContent jsonContentByteArray = new ByteArrayContent(Encoding.UTF8.GetBytes(jsonContent));
                        jsonContentByteArray.Headers.ContentType = new MediaTypeHeaderValue("application/json");

                        form.Add(jsonContentByteArray, "document");

                        // Crea la parte del file PDF
                        byte[] fileBytes = File.ReadAllBytes(filePath);
                        ByteArrayContent fileContent = new ByteArrayContent(fileBytes);
                        fileContent.Headers.ContentType = new MediaTypeHeaderValue("application/pdf");
                        form.Add(fileContent, "attachment", filename);

                        // Invia la richiesta POST sincrona
                        HttpResponseMessage response = client.PostAsync(ConfigurationManager.AppSettings["url_documents_upload"], form).Result;

                        // Controlla la risposta
                        if (response.IsSuccessStatusCode)
                        {
                            Console.WriteLine($"Uploaded file {filePath} to {ConfigurationManager.AppSettings["url_documents_upload"]}");
                            return (int)response.StatusCode;
                        }
                        else
                        {
                            Console.WriteLine($"Error uploading file {filePath}: {response.ReasonPhrase}");
                            return null;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error uploading file {filePath}: {ex.Message}");
                return null;
            }
        }
    }
}


using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading.Tasks;

namespace SpedireOnLinePostDocument.ApiChatGPT
{
    public class Request
    {
        public static Reference.RootMessageContent CreateWaybill(string JsonStr, int id, string ws, string clientID, string access_token)
        {
            Reference.RootMessageContent ResponsePDB = new Reference.RootMessageContent();

            try
            {
                ServicePointManager.ServerCertificateValidationCallback = new System.Net.Security.RemoteCertificateValidationCallback(AcceptAllCertifications);
                WebRequest request = WebRequest.Create(ws);

                request.ContentType = "application/json";
                request.Method = "POST";
                request.Headers.Add("Authorization", "Bearer " + "YOUR_OPENAI_API_KEY_HERE");

                using (var streamWriter = new StreamWriter(request.GetRequestStream()))
                {
                    string json = JsonStr;

                    streamWriter.Write(json);
                    streamWriter.Flush();
                }
                // If required by the server, set the credentials.  
                request.Credentials = CredentialCache.DefaultCredentials;
                // Get the response.  
                WebResponse response = request.GetResponse();
                // Display the status.  
                // Console.WriteLine (((HttpWebResponse)response).StatusDescription);  
                // Get the stream containing content returned by the server.  
                Stream dataStream = response.GetResponseStream();
                // Open the stream using a StreamReader for easy access.  
                StreamReader reader = new StreamReader(dataStream);
                // Read the content.  
                string responseFromServer = reader.ReadToEnd();
                // Display the content.  
                Console.WriteLine(responseFromServer);
                // Clean up the streams and the response.   
                reader.Close();
                response.Close();

                ResponsePDB = JsonConvert.DeserializeObject<Reference.RootMessageContent>(responseFromServer);

                return ResponsePDB;
            }
            catch (Exception e)
            {
                return null;
            }
        }

        private static bool AcceptAllCertifications(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors sslPolicyErrors)
        {
            return true;

        }
    }
}


using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace SpedireOnLinePostDocument
{
    public class Reference
    {
        public class Message4o
        {
            public string role { get; set; }
            public List<Content4o> content { get; set; }

        }

        public class Message
        {
            public string role { get; set; }
            public string content { get; set; }

        }
        public class Content4o
        {
            public string type { get; set; }
            public string text { get; set; }
            public ImageUrl image_url { get; set; }
        }

        public class ImageUrl
        {
            public string url { get; set; }
        }
        public class RootMessage
        {
            public string model { get; set; }
            public List<Message> messages { get; set; }
            public double temperature { get; set; }
        }
        public class RootMessage4o
        {
            public string model { get; set; }
            public List<Message4o> messages { get; set; }
            public double temperature { get; set; }
        }
        public class Choice
        {
            public int index { get; set; }
            public Message message { get; set; }
            public string finish_reason { get; set; }
        }

        public class RootMessageContent
        {
            public string id { get; set; }
            public string @object { get; set; }
            public int created { get; set; }
            public string model { get; set; }
            public List<Choice> choices { get; set; }
            public Usage usage { get; set; }
        }

        public class Usage
        {
            public int prompt_tokens { get; set; }
            public int completion_tokens { get; set; }
            public int total_tokens { get; set; }
        }


        // Root myDeserializedClass = JsonConvert.DeserializeObject<Root>(myJsonResponse);
        public class RootMessageAssistance
        {
            public string ragionesocialedestinazione { get; set; }
            public string riferimentodestinazione { get; set; }
            public string indirizzodestinazione { get; set; }
            public string numerocivico { get; set; }
            public string capdestinazione { get; set; }
            public string cittadestinazione { get; set; }
            public string provinciadestinazione { get; set; }
            public string telefonodestinazione { get; set; }
            public string emaildestinazione { get; set; }
            public string nazionedestinazione { get; set; }
            public string documentn { get; set; }
            public string importocontrassegno { get; set; }
            public string numerocolli { get; set; }
            public string peso { get; set; }
            public string aspettobeni { get; set; }
            public string vettore { get; set; }
            public string stato { get; set; }
            public string palazzinadestinazione { get; set; }
            public string scaladestinazione { get; set; }
            public string internodestinazione { get; set; }
            public string ufficiodestinazione { get; set; }
            public string notedestinazione { get; set; }

        }

    }

}


using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace SpedireOnLinePostDocument.ApiChatGPT
{
    public class Function
    {
        public static string elaborazioneAi(string _testo)
        {
            Reference.RootMessageContent rootMessageContent = new Reference.RootMessageContent();

            Reference.RootMessage rootMessage = new Reference.RootMessage();

            Reference.Message _message = new Reference.Message();

            List<Reference.Message> message = new List<Reference.Message>();

            rootMessage.model = "gpt-4o-mini";
            rootMessage.temperature = 0.7;
            _message.role = "user";
            _message.content = "Trova i dati di destinazione della merce, organizza il risultato in campi json, se non li trovi popola i campi con stringa vuota nel seguente formato ragionesocialedestinazione, riferimentodestinazione, indirizzodestinazione, capdestinazione, cittadestinazione, provinciadestinazione, telefonodestinazione, emaildestinazione, documentn , importocontrassegno, numerocolli, peso, aspettobeni, vettore:  " + _testo;

            message.Add(_message);

            rootMessage.messages = message;

            string json = JsonConvert.SerializeObject(rootMessage);

            rootMessageContent = Request.CreateWaybill(json.Replace("\n", " "), 0, "https://api.openai.com/v1/chat/completions", "", "");

            rootMessageContent.choices[0].message.content = rootMessageContent.choices[0].message.content.Substring(rootMessageContent.choices[0].message.content.IndexOf("{"));
            rootMessageContent.choices[0].message.content = rootMessageContent.choices[0].message.content.Substring(0, rootMessageContent.choices[0].message.content.IndexOf("}") + 1);

            return rootMessageContent.choices[0].message.content;
        }

        public static string SchiaviAIPO(string _testo)
        {
            Reference.RootMessageContent rootMessageContent = new Reference.RootMessageContent();

            Reference.RootMessage rootMessage = new Reference.RootMessage();

            Reference.Message _message = new Reference.Message();

            List<Reference.Message> message = new List<Reference.Message>();

            rootMessage.model = "gpt-4o-mini";
            rootMessage.temperature = 0.7;
            _message.role = "user";
            _message.content = @"
Estrai i dati dal seguente testo di ordine di acquisto e restituiscili in formato JSON seguendo questa struttura:
{
  ""po_number"": """",
  ""po_revision"": 0,
  ""po_date"": """",
  ""po_effective_start"": """",
  ""po_effective_end"": null,
  ""buyer"": """",
  ""supplier_name"": """",
  ""supplier_address"": """",
  ""bill_to_name"": """",
  ""bill_to_address"": """",
  ""po_description"": """",
  ""supplier_number"": """",
  ""payment_terms"": """",
  ""currency"": """",
  ""line_number"": 1,
  ""part_number"": """",
  ""item_description"": """",
  ""quantity"": 0.0,
  ""uom"": """",
  ""unit_price"": 0.0,
  ""need_by_date"": """",
  ""requestor_name"": """",
  ""requestor_email"": """",
  ""ship_to_address"": """",
  ""line_total"": 0.0,
  ""plate_number"": """",
  ""vin"": """",
  ""unit_number"": """",
  ""model"": """",
  ""country"": """",
  ""type"": """",
  ""mileage"": """",
  ""vehicle_category"": """",
  ""comments"": """"
}

Testo da analizzare:
" + _testo;


            message.Add(_message);

            rootMessage.messages = message;

            string json = JsonConvert.SerializeObject(rootMessage);

            rootMessageContent = Request.CreateWaybill(json.Replace("\n", " "), 0, "https://api.openai.com/v1/chat/completions", "", "");

            rootMessageContent.choices[0].message.content = rootMessageContent.choices[0].message.content.Substring(rootMessageContent.choices[0].message.content.IndexOf("{"));
            rootMessageContent.choices[0].message.content = rootMessageContent.choices[0].message.content.Substring(0, rootMessageContent.choices[0].message.content.IndexOf("}") + 1);

            return rootMessageContent.choices[0].message.content;
        }
    }
}
