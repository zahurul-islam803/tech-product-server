const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");
const port = process.env.PORT || 5000;

const stripe = require("stripe")(process.env.PAYMENT_SECRET_KEY);

// middleware
const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174"],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));
const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  console.log(token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err);
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

const client = new MongoClient(process.env.DB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const usersCollection = client.db("techHavenDb").collection("users");
    const subscriptionCollection = client
      .db("techHavenDb")
      .collection("subscriptions");
    const productsCollection = client.db("techHavenDb").collection("products");
    const reviewsCollection = client.db("techHavenDb").collection("reviews");

    // role verification middleware
    // for admin
    const verifyAdmin = async (req, res, next) => {
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== "admin")
        return res.status(401).send({ message: "unauthorized access!" });
      next();
    };

    // for moderator
    const verifyModerator = async (req, res, next) => {
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== "moderator")
        return res.status(401).send({ message: "unauthorized access!" });
      next();
    };

    // auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });

    // Logout
    app.get("/logout", async (req, res) => {
      try {
        res
          .clearCookie("token", {
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
          })
          .send({ success: true });
        console.log("Logout successful");
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Save or modify user email, status in Database
    app.put("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email: email };
      const options = { upsert: true };
      const isExist = await usersCollection.findOne(query);
      if (isExist) {
        if (user?.status === "Requested") {
          const result = await usersCollection.updateOne(
            query,
            {
              $set: user,
            },
            options
          );
          return res.send(result);
        } else {
          return res.send(isExist);
        }
      }
      const result = await usersCollection.updateOne(
        query,
        {
          $set: { ...user, timestamp: Date.now() },
        },
        options
      );
      res.send(result);
    });

    // get product data depend on categories
    app.get("/products", verifyToken, async (req, res) => {
      let queryObj = {};
      let sortObj = {};
      const category = req.query.category;
      const sortField = req.query.sortField;
      const sortOrder = req.query.sortOrder;
      const page = Number(req.query.page);
      const limit = Number(req.query.limit);
      const skip = (page - 1) * limit;
      if (category) {
        queryObj.category = category;
      }
      if (sortField && sortOrder) {
        sortObj[sortField] = sortOrder;
      }
      const result = await productsCollection
        .find(queryObj)
        .skip(skip)
        .limit(limit)
        .sort(sortObj)
        .toArray();
      const total = await productsCollection.countDocuments();
      res.send({ total, result });
    });

    // get single product data
    app.get("/product/:id", async (req, res) => {
      const id = req.params.id;
      const result = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    //save product in the database
    app.post("/products", verifyToken, async (req, res) => {
      const product = req.body;
      const result = await productsCollection.insertOne(product);
      res.send(result);
    });

    //save review for product in the database
    app.post("/reviews", verifyToken, async (req, res) => {
      const review = req.body;
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });

    // get product review data
    app.get("/reviews", verifyToken, async (req, res) => {
      const result = await reviewsCollection.find().toArray();
      res.send(result);
    });

    // delete products
    app.delete("/products/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await productsCollection.deleteOne(query);
      res.send(result);
    });

    // generate client secret for payment intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      if (!price || amount < 1) return;
      const { client_secret } = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });
      res.send({ clientSecret: client_secret });
    });

    // save subscription info in subscriptionCollection
    app.post("/subscription", verifyToken, async (req, res) => {
      const subscription = req.body;
      const result = await subscriptionCollection.insertOne(subscription);
      // send email
      res.send(result);
    });

    // get subscription collection for guest
    app.get("/subscriptions", verifyToken, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.send([]);
      const query = { "guest.email": email };
      const result = await subscriptionCollection.find(query).toArray();
      res.send(result);
    });

    // get all users
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // get role
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    // update users role
    app.put("/users/update/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email: email };
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          ...user,
          timestamp: Date.now(),
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc, options);
      res.send(result);
    });

    // chart analytics
    // app.get('/admin-stats', verifyToken,  async (req, res,) => {
    //   const users = await usersCollection.estimatedDocumentCount();
    //   const products = await productsCollection.estimatedDocumentCount();
    //   const reviews = await reviewsCollection.estimatedDocumentCount();
    //   res.send({users, products, reviews});
    // })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from TechHaven Server..");
});

app.listen(port, () => {
  console.log(`TechHaven is running on port ${port}`);
});

