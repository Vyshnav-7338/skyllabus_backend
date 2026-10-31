const express = require('express');
const bodyParser = require('body-parser');
const myRouter = express.Router();
var auth = require('../auth/authenticate');
var config = require("../config")
const fs = require('fs');

myRouter.use(bodyParser.json());
var cdndir = config.live ? config.cdndir_live : config.cdndir_local
//GET ALL
myRouter.get(`/cdn`, async (req, res) => {
    console.log("cdn called")//
    var fileid = req.query.file;
    console.log(fileid)
    res.sendFile(cdndir + fileid)
})


myRouter.delete(`/cdn`, async (req, res) => {
    console.log("Delete CDN called");

    var fileid = req.query.file;
    if (!fileid) {
        return res.status(400).send("File ID is required");
    }
    var filePath = cdndir + fileid;

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }

    fs.unlink(filePath, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send("Error deleting file");
        }
        console.log("File deleted successfully");
        return res.status(200).send("File deleted successfully");
    });
});

// DOWNLOAD File from CDN
myRouter.get('/download', async (req, res) => {
    const fileid = req.query.file;
    console.log("Download request for file:", fileid);

    if (!fileid) {
        return res.status(400).send("File ID is required");
    }
    const filePath = cdndir + fileid;
    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }
    res.download(filePath, fileid, (err) => {
        if (err) {
            console.error("Error downloading file:", err);
            return res.status(500).send("Error downloading file");
        }
    });
});

myRouter.get('/openFile', async (req, res) => {
    const fileid = req.query.file;
    console.log("Opening request for file:", fileid);

    if (!fileid) {
        return res.status(400).send("File ID is required");
    }
    const filePath = cdndir + fileid;
    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }
    res.sendFile(filePath, fileid, (err) => {
        if (err) {
            console.error("Error Opening file:", err);
            return res.status(500).send("Error Opening file");
        }
    });
});

module.exports = myRouter