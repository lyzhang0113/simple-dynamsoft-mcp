// Configuration object for initializing the BarcodeScanner instance. Refer to https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/api-reference/barcode-scanner.html#barcodescannerconfig
let config = {
  license: "DLS2eyJoYW5kc2hha2VDb2RlIjoiMjAwMDAxLTE2NDk4Mjk3OTI2MzUiLCJvcmdhbml6YXRpb25JRCI6IjIwMDAwMSIsInNlc3Npb25QYXNzd29yZCI6IndTcGR6Vm05WDJrcEQ5YUoifQ==", // Replace with your Dynamsoft license key
  container: document.querySelector(".barcode-scanner-view"), // Specify where to render the scanner UI

  // showUploadImageButton: true,
  // scannerViewConfig: {
  //   showFlashButton: true,
  //   cameraSwitchControl: "toggleFrontBack",
  // },
};

// Create a new instance of the Dynamsoft Barcode Scanner
const barcodeScanner = new Dynamsoft.BarcodeScanner(config);

// Launch the scanner and handle the scanned result
barcodeScanner.launch().then((result) => {
  // Display the first detected barcode's text in an alert
  if (result.barcodeResults.length) {
    alert(result.barcodeResults[0].text);
  }
});
